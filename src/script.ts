import { Chess } from 'chess.js';
import $ from 'jquery';

// Make jQuery available globally for chessboard.js
(window as any).$ = $;
(window as any).jQuery = $;

// Register service worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(registration => {
                console.log('SW registered: ', registration);
            })
            .catch(registrationError => {
                console.log('SW registration failed: ', registrationError);
            });
    });
}

declare var Chessboard: any;

let board: any = null;
let game = new Chess();
let stockfish: any = null;
let isStockfishReady = false;
let newGameConfirmPending = false;
let newGameRevertTimer: any = null;

// Time control variables
let whiteTimeMs = 60000; // 1 minute
let blackTimeMs = 60000;
let whiteIncrementMs = 1000; // 1 second
let blackIncrementMs = 1000;
let clockInterval: any = null;
let clockStarted = false;
let lastMoveTime = 0;

// Computer move limits
let whiteMovesRemaining = 1;
let blackMovesRemaining = 1;

// Options menu state
let optionsState = {
    whiteMinutes: 1,
    whiteIncrement: 1,
    blackMinutes: 1,
    blackIncrement: 1,
    whiteComputerMoves: 1,
    blackComputerMoves: 1
};

// Game archive interface
interface ArchivedGame {
    pgn: string;
    timestamp: number;
    winner: string;
    whiteTimeControl: string;
    blackTimeControl: string;
    whiteHints: number;
    blackHints: number;
}

const NNUE_BIG = "nn-1c0000000000.nnue";
const NNUE_SMALL = "nn-37f18f62d772.nnue";

async function openIndexDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('one-hint-chess', 1);
        request.onupgradeneeded = (event) => {
            const db = (event.target as any).result;
            if (!db.objectStoreNames.contains('nnue')) {
                db.createObjectStore('nnue');
            }
        };
        request.onsuccess = (event) => {
            resolve((event.target as any).result);
        };
        request.onerror = (event) => {
            reject(new Error('Failed to open IndexedDB'));
        };
    });
}

async function getNnue(key: string): Promise<Uint8Array | null> {
    const db = await openIndexDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('nnue', 'readonly');
        const store = transaction.objectStore('nnue');
        const request = store.get(key);
        request.onsuccess = (event) => {
            const result = (event.target as any).result;
            if (result) {
                resolve(new Uint8Array(result));
            } else {
                resolve(null);
            }
        };
        request.onerror = () => {
            reject(new Error('Failed to get NNUE data'));
        };
    });
}

async function loadStockfish(): Promise<void> {
    console.log('Preparing for offline use...');
    // Wait for service worker to be ready so our fetch requests can be intercepted
    await navigator.serviceWorker.ready;

    // Check if we have the NNUE files and prompt to download if not.
    const smallExists = await getNnue(NNUE_SMALL);
    const bigExists = await getNnue(NNUE_BIG);
    if (!smallExists || !bigExists) {
        console.log("Asking to download NNUE files...");
        console.log("Small NNUE file exists:", !!smallExists);
        console.log("Big NNUE file exists:", !!bigExists);
        showDownloadDialog();
        return;
    }

    // Check if SharedArrayBuffer is supported.
    // This should work after reloading the page after downloading the NNUE files,
    // since our service worker will set the correct headers.
    if (typeof SharedArrayBuffer === 'undefined') {
        console.warn('SharedArrayBuffer is not supported. Stockfish NNUE will not work.');
        return;
    }

    console.log('Loading Stockfish...');

    try {
        // Load Stockfish script dynamically as ES module
        const stockfishModule = await eval(`import('/one-hint-chess/fish/sf171-79.js')`);
        // Create the Stockfish instance
        stockfish = await stockfishModule.default();

        // Set up output handler
        stockfish.listen = (line: string) => {
            console.log('[stockfish]', line);
        };
        stockfish.error = (line: any) => {
            console.warn('[stockfish]', line);
        };

        // Load NNUE files
        const bigBuffer = await getNnue(NNUE_BIG);
        const smallBuffer = await getNnue(NNUE_SMALL);
        stockfish.setNnueBuffer(bigBuffer, 0);
        stockfish.setNnueBuffer(smallBuffer, 1);
        console.log('NNUE files loaded successfully');

        isStockfishReady = true;
        $('#blackComputerMoveBtn, #whiteComputerMoveBtn').prop('disabled', false);
        console.log('Stockfish ready!');

    } catch (error) {
        // At least offline chess without stockfish can be played.
        console.error('Failed to load Stockfish:', error);
    }
}

function showDownloadDialog(): void {
    const dialog = document.getElementById('downloadDialog');
    if (dialog) {
        dialog.style.display = 'flex';
    }
}

function hideDownloadDialog(): void {
    const dialog = document.getElementById('downloadDialog');
    if (dialog) {
        dialog.style.display = 'none';
    }
}

async function downloadNnueFile(filename: string, progressElementId: string): Promise<void> {
    const url = `fish/${filename}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to download ${filename}: ${response.statusText}`);
        }

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('Failed to get response reader');
        }

        const chunks: Uint8Array[] = [];
        let downloaded = 0;

        const progressElement = document.getElementById(progressElementId) as HTMLElement;

        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            chunks.push(value);
            downloaded += value.length;

            if (total > 0) {
                const progress = (downloaded / total) * 100;
                if (progressElement) {
                    progressElement.style.width = `${progress}%`;
                }
            }
        }

        // Combine all chunks into a single Uint8Array
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        // Store in IndexedDB
        const db = await openIndexDb();
        const transaction = db.transaction('nnue', 'readwrite');
        const store = transaction.objectStore('nnue');
        await new Promise<void>((resolve, reject) => {
            const request = store.put(result.buffer, filename);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(new Error(`Failed to store ${filename} in IndexedDB`));
        });

        console.log(`Successfully downloaded and stored ${filename}`);

    } catch (error) {
        console.error(`Error downloading ${filename}:`, error);
        throw error;
    }
}

async function downloadAllNnueFiles(): Promise<void> {
    const progressSection = document.getElementById('progressSection');
    const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement;
    const cancelBtn = document.getElementById('cancelDownloadBtn') as HTMLButtonElement;

    if (progressSection) {
        progressSection.style.display = 'block';
    }

    if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.textContent = 'Downloading...';
    }

    if (cancelBtn) {
        cancelBtn.disabled = true;
    }

    try {
        await downloadNnueFile(NNUE_SMALL, 'smallProgress');
        await downloadNnueFile(NNUE_BIG, 'bigProgress');

        console.log('All NNUE files downloaded successfully');
        hideDownloadDialog();
        // Reload to re-initialize. This also fixes the headers needed for SharedArrayBuffer.
        window.location.reload();
    } catch (error) {
        console.error('Error downloading NNUE files:', error);
        alert('Failed to download files. Please try again.');

        // Reset UI state
        if (downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.textContent = 'Download';
        }

        if (cancelBtn) {
            cancelBtn.disabled = false;
        }
    }
}

function onDragStart(source: string, piece: string, _position: any, _orientation: string): boolean {
    if (game.isGameOver()) return false;

    if ((game.turn() === 'w' && piece.search(/^b/) !== -1) ||
        (game.turn() === 'b' && piece.search(/^w/) !== -1)) {
        return false;
    }

    // Clear any existing highlights first
    clearHighlights();
    // Highlight valid moves
    highlightValidMoves(source);
    return true;
}

function onDrop(source: string, target: string): string | void {
    // Clear highlights first
    clearHighlights();

    try {
        const move = game.move({
            from: source,
            to: target,
            promotion: 'q'
        });

        if (move === null) return 'snapback';

        // Add time increment for the player who just moved
        addTimeIncrement();

        // Start the clock after white's first move
        if (game.history().length === 1) {
            startClock();
        }

        updateStatus();
        updateClockDisplay();
        highlightKingInCheck();
    } catch (error) {
        // Invalid move attempted.
        return 'snapback';
    }
}

function onSnapEnd(): void {
    board.position(game.fen());
    // Clear move highlights when drag ends
    clearHighlights();
}

function highlightValidMoves(square: string): void {
    // Get all possible moves for the current position
    const moves = game.moves({ square: square as any, verbose: true });

    // Add highlighting to valid target squares
    moves.forEach((move: any) => {
        const targetSquare = $(`#myBoard .square-${move.to}`);

        // Check if this is a capture move (target square has a piece)
        if (move.captured || targetSquare.find('.piece-417db').length > 0) {
            targetSquare.addClass('highlight-capture');
        } else {
            targetSquare.addClass('highlight-move');
        }
    });
}

function clearHighlights(): void {
    $('#myBoard .highlight-move').removeClass('highlight-move');
    $('#myBoard .highlight-capture').removeClass('highlight-capture');
}

function highlightKingInCheck(): void {
    // Clear any existing king check highlights
    $('#myBoard .king-in-check').removeClass('king-in-check');

    if (game.inCheck()) {
        // Find the king square for the current player
        const currentPlayer = game.turn();
        const kingPiece = currentPlayer === 'w' ? 'wK' : 'bK';

        // Search for the king on the board
        const board = game.board();
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const piece = board[row][col];
                if (piece && piece.type === 'k' && piece.color === currentPlayer) {
                    // Convert row/col to chess notation (e.g., e1, e8)
                    const file = String.fromCharCode(97 + col); // a-h
                    const rank = (8 - row).toString(); // 1-8
                    const square = file + rank;

                    // Add highlight class to the king's square
                    $(`.square-${square}`).addClass('king-in-check');
                    break;
                }
            }
        }
    }
}

function formatTime(ms: number): string {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function updateClockDisplay(): void {
    const whiteTimeFormatted = formatTime(whiteTimeMs);
    const blackTimeFormatted = formatTime(blackTimeMs);

    // Update black time displays (top bar)
    $('#blackTimeTopLeft').text(blackTimeFormatted);
    $('#blackTimeTopRight').text(blackTimeFormatted);

    // Update white time displays (bottom bar)
    $('#whiteTimeBottomLeft').text(whiteTimeFormatted);
    $('#whiteTimeBottomRight').text(whiteTimeFormatted);

    // Update computer moves remaining displays
    $('#blackMovesTopLeft').text(blackMovesRemaining);
    $('#blackMovesTopRight').text(blackMovesRemaining);
    $('#whiteMovesBottomLeft').text(whiteMovesRemaining);
    $('#whiteMovesBottomRight').text(whiteMovesRemaining);

    // Update clock styles and button states based on active player
    $('#whiteClock, #blackClock').removeClass('active');
    const currentPlayer = game.turn();

    if (clockStarted && !game.isGameOver()) {
        if (currentPlayer === 'w') {
            $('#whiteClock').addClass('active');
        } else {
            $('#blackClock').addClass('active');
        }
    }

    // Update computer move button visibility and states
    if (whiteMovesRemaining > 0) {
        $('#whiteComputerMoveBtn').show();
        if (isStockfishReady && !game.isGameOver() && currentPlayer === 'w') {
            $('#whiteComputerMoveBtn').prop('disabled', false);
        } else {
            $('#whiteComputerMoveBtn').prop('disabled', true);
        }
    } else {
        $('#whiteComputerMoveBtn').hide();
    }

    if (blackMovesRemaining > 0) {
        $('#blackComputerMoveBtn').show();
        if (isStockfishReady && !game.isGameOver() && currentPlayer === 'b') {
            $('#blackComputerMoveBtn').prop('disabled', false);
        } else {
            $('#blackComputerMoveBtn').prop('disabled', true);
        }
    } else {
        $('#blackComputerMoveBtn').hide();
    }

    // Add warning classes for low time
    const whiteClock = $('#whiteClock');
    const blackClock = $('#blackClock');

    whiteClock.removeClass('low-time very-low-time');
    blackClock.removeClass('low-time very-low-time');

    if (whiteTimeMs <= 10000) { // 10 seconds
        whiteClock.addClass('very-low-time');
    } else if (whiteTimeMs <= 30000) { // 30 seconds
        whiteClock.addClass('low-time');
    }

    if (blackTimeMs <= 10000) { // 10 seconds
        blackClock.addClass('very-low-time');
    } else if (blackTimeMs <= 30000) { // 30 seconds
        blackClock.addClass('low-time');
    }
}

function startClock(): void {
    if (clockInterval) {
        clearInterval(clockInterval);
    }

    lastMoveTime = Date.now();
    clockStarted = true;

    clockInterval = setInterval(() => {
        const now = Date.now();
        const elapsed = now - lastMoveTime;

        if (game.turn() === 'w') {
            whiteTimeMs = Math.max(0, whiteTimeMs - elapsed);
            if (whiteTimeMs === 0) {
                stopClock();
                showGameOverModal('Black wins', 'on time');
                return;
            }
        } else {
            blackTimeMs = Math.max(0, blackTimeMs - elapsed);
            if (blackTimeMs === 0) {
                stopClock();
                showGameOverModal('White wins', 'on time');
                return;
            }
        }

        lastMoveTime = now;
        updateClockDisplay();
    }, 100); // Update every 100ms for smooth countdown
}

function stopClock(): void {
    if (clockInterval) {
        clearInterval(clockInterval);
        clockInterval = null;
    }
    $('#whiteClock, #blackClock').removeClass('active');
    updateClockDisplay();
}

function addTimeIncrement(): void {
    // Add increment to the player who just moved
    if (game.turn() === 'b') {
        // White just moved
        whiteTimeMs += whiteIncrementMs;
    } else {
        // Black just moved
        blackTimeMs += blackIncrementMs;
    }
}

function getGameResult(): { winner: string; reason: string } {
    const currentPlayer = game.turn();
    const opponentColor = currentPlayer === 'w' ? 'Black' : 'White';

    if (game.isCheckmate()) {
        return {
            winner: `${opponentColor} wins`,
            reason: 'by checkmate'
        };
    } else if (game.isStalemate()) {
        return {
            winner: 'Draw',
            reason: 'by stalemate'
        };
    } else if (game.isThreefoldRepetition()) {
        return {
            winner: 'Draw',
            reason: 'by repetition'
        };
    } else if (game.isInsufficientMaterial()) {
        return {
            winner: 'Draw',
            reason: 'by insufficient material'
        };
    } else if (game.isDraw()) {
        // This catches other draw conditions like 50-move rule
        return {
            winner: 'Draw',
            reason: 'by 50-move rule'
        };
    }

    return { winner: '', reason: '' };
}

function updateStatus(): void {
    const result = getGameResult();

    if (result.winner) {
        stopClock();
        showGameOverModal(result.winner, result.reason);
    }
}

function newGame(): void {
    // Check if it's a fresh game (no moves made)
    if (game.history().length === 0) {
        // Fresh game, no confirmation needed
        game.reset();
        board.start();
        updateStatus();
        return;
    }

    // Game in progress, require confirmation
    if (!newGameConfirmPending) {
        // First click - show confirmation
        newGameConfirmPending = true;
        const newGameBtn = $('.corner-btn.bottom-left');
        newGameBtn.text('Really?').addClass('confirm-pending');

        // Clear any existing timer
        if (newGameRevertTimer) {
            clearTimeout(newGameRevertTimer);
        }

        // Auto-revert after 1 second
        newGameRevertTimer = setTimeout(() => {
            revertNewGameButton();
        }, 1000);
    } else {
        // Second click - confirm and start new game
        confirmNewGame();
    }
}

function revertNewGameButton(): void {
    newGameConfirmPending = false;
    if (newGameRevertTimer) {
        clearTimeout(newGameRevertTimer);
        newGameRevertTimer = null;
    }
    const newGameBtn = $('.corner-btn.bottom-left');
    newGameBtn.text('New Game').removeClass('confirm-pending');
}

function confirmNewGame(): void {
    newGameConfirmPending = false;
    if (newGameRevertTimer) {
        clearTimeout(newGameRevertTimer);
        newGameRevertTimer = null;
    }

    // Reset the button appearance
    const newGameBtn = $('.corner-btn.bottom-left');
    newGameBtn.text('New Game').removeClass('confirm-pending');

    // Save current game if it has moves and isn't already over
    if (game.history().length > 0 && !game.isGameOver()) {
        const currentPlayer = game.turn();
        const winner = 'Game abandoned';
        saveGameToArchive(winner);
    }

    // Reset time control and computer moves
    stopClock();
    whiteTimeMs = optionsState.whiteMinutes * 60000;
    blackTimeMs = optionsState.blackMinutes * 60000;
    whiteIncrementMs = optionsState.whiteIncrement * 1000;
    blackIncrementMs = optionsState.blackIncrement * 1000;
    whiteMovesRemaining = optionsState.whiteComputerMoves;
    blackMovesRemaining = optionsState.blackComputerMoves;
    clockStarted = false;

    // Start new game
    game.reset();
    board.start();
    updateStatus();
    updateClockDisplay();
    highlightKingInCheck();
}

function saveGameToArchive(winner: string): void {
    const pgn = game.pgn();
    if (!pgn || game.history().length === 0) {
        return;
    }

    const whiteTimeControl = `${optionsState.whiteMinutes}+${optionsState.whiteIncrement}`;
    const blackTimeControl = `${optionsState.blackMinutes}+${optionsState.blackIncrement}`;
    const archivedGame: ArchivedGame = {
        pgn: pgn,
        timestamp: Date.now(),
        winner: winner,
        whiteTimeControl: whiteTimeControl,
        blackTimeControl: blackTimeControl,
        whiteHints: optionsState.whiteComputerMoves - whiteMovesRemaining,
        blackHints: optionsState.blackComputerMoves - blackMovesRemaining
    };

    const existingGames = getArchivedGames();
    existingGames.unshift(archivedGame);

    localStorage.setItem('oneHintChessArchive', JSON.stringify(existingGames));
}

function getArchivedGames(): ArchivedGame[] {
    const stored = localStorage.getItem('oneHintChessArchive');
    return stored ? JSON.parse(stored) : [];
}

function showGameArchive(): void {
    const archiveList = document.getElementById('archive-list');
    const noGamesMessage = document.getElementById('no-games-message');
    if (!archiveList || !noGamesMessage) return;

    const games = getArchivedGames();

    if (games.length === 0) {
        noGamesMessage.style.display = 'block';
    } else {
        noGamesMessage.style.display = 'none';
        archiveList.innerHTML = '';

        games.forEach((game, index) => {
            const gameDiv = document.createElement('div');
            gameDiv.className = 'archived-game';
            gameDiv.onclick = () => openLichessAnalysis(game.pgn);

            const date = new Date(game.timestamp);
            const timeStr = date.getFullYear() + '-' +
                String(date.getMonth() + 1).padStart(2, '0') + '-' +
                String(date.getDate()).padStart(2, '0') + ' ' +
                String(date.getHours()).padStart(2, '0') + ':' +
                String(date.getMinutes()).padStart(2, '0') + ':' +
                String(date.getSeconds()).padStart(2, '0');

            const whiteTC = game.whiteTimeControl;
            const blackTC = game.blackTimeControl;

            gameDiv.innerHTML = `
                <div class="game-info">
                    <div class="game-header">
                        <span class="game-date">${timeStr}</span>
                        <span class="game-winner">${game.winner}</span>
                    </div>
                    <div class="game-details">
                        <span class="player-details">White: ${whiteTC}, ${game.whiteHints} hints  Black: ${blackTC}, ${game.blackHints} hints</span>
                    </div>
                </div>
            `;

            archiveList.appendChild(gameDiv);
        });
    }

    $('#gameArchiveModal').show();
}

function closeGameArchive(): void {
    $('#gameArchiveModal').hide();
}

function openLichessAnalysis(pgn: string): void {
    const encodedPgn = encodeURIComponent(pgn);
    const lichessUrl = `https://lichess.org/analysis/pgn/${encodedPgn}`;
    window.open(lichessUrl, '_blank');
}

function showGameOverModal(winner: string, reason: string): void {
    const fullResult = `${winner} ${reason}`;
    saveGameToArchive(fullResult);
    $('#gameOverTitle').text('Game Over');
    $('#gameOverMessage').text(fullResult);
    $('#gameOverModal').show();
}

function closeModalAndNewGame(): void {
    $('#gameOverModal').hide();
    // Skip confirmation for modal new game since game is already over
    confirmNewGame();
}

function analyzeGame(): void {
    // Get the PGN of the current game
    const pgn = game.pgn();

    if (!pgn || game.history().length === 0) {
        alert('No moves to analyze!');
        return;
    }

    // Encode the PGN for URL
    const encodedPgn = encodeURIComponent(pgn);

    // Open Lichess analysis page with the PGN
    const lichessUrl = `https://lichess.org/analysis/pgn/${encodedPgn}`;
    window.open(lichessUrl, '_blank');
}

function initializeChess(): void {
    const config = {
        draggable: true,
        position: 'start',
        onDragStart: onDragStart,
        onDrop: onDrop,
        onSnapEnd: onSnapEnd,
        pieceTheme: 'chesspieces/wikipedia/{piece}.png',
    };

    board = Chessboard('myBoard', config);

    // Make board responsive
    function resizeBoard() {
        board.resize();
    }

    // Resize board on window resize
    $(window).resize(resizeBoard);

    // Add click handler to board to allow deselection
    $('#myBoard').on('click', function (e) {
        // If clicking on empty square, clear highlights
        const $target = $(e.target);
        if ($target.hasClass('square-55d63') && !$target.hasClass('piece-417db') && $target.children('.piece-417db').length === 0) {
            clearHighlights();
        }
    });

    // Add escape key handler to clear selection
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape') {
            clearHighlights();
        }
    });

    // Clear highlights when mouse leaves the board area
    $('#myBoard').on('mouseleave', function () {
        // Small delay to prevent clearing when dragging to edge
        setTimeout(() => {
            if (!$('#myBoard .piece-417db').is(':visible') || !document.querySelector('.piece-417db:hover')) {
                clearHighlights();
            }
        }, 100);
    });

    newGame();

    // Initialize clock display
    updateClockDisplay();
    highlightKingInCheck();
}

function updateComputerMoveProgress(percentage: number): void {
    // Only update progress for the current player's button
    const currentPlayer = game.turn();
    const btn = currentPlayer === 'w' ? $('#whiteComputerMoveBtn') : $('#blackComputerMoveBtn');
    btn.css('--progress', `${percentage}%`);
}

function resetComputerMoveButton(): void {
    const btn = $('#blackComputerMoveBtn, #whiteComputerMoveBtn');
    btn.removeClass('thinking')
        .prop('disabled', false)
        .css('--progress', '0%');
}

function setComputerMoveThinking(): void {
    // Only show thinking state on the current player's button
    const currentPlayer = game.turn();
    const btn = currentPlayer === 'w' ? $('#whiteComputerMoveBtn') : $('#blackComputerMoveBtn');
    btn.addClass('thinking')
        .prop('disabled', true)
        .css('--progress', '0%');
}

async function loadChessboard(): Promise<void> {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        // Import the chessboard script as a URL using Vite's ?url suffix
        import('@chrisoakman/chessboardjs/dist/chessboard-1.0.0.min.js?url').then((module) => {
            script.src = module.default;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load chessboard.js'));
            document.head.appendChild(script);
        }).catch(reject);
    });
}

async function makeComputerMove(): Promise<void> {
    if (!stockfish || !isStockfishReady || game.isGameOver()) {
        return;
    }

    // Check if current player has moves remaining
    const currentPlayer = game.turn();
    if ((currentPlayer === 'w' && whiteMovesRemaining <= 0) ||
        (currentPlayer === 'b' && blackMovesRemaining <= 0)) {
        return;
    }

    const targetDepth = 20;
    setComputerMoveThinking();

    try {
        // Set up position
        const fen = game.fen();
        stockfish.uci(`position fen ${fen}`);

        const movePromise = new Promise<string>((resolve) => {
            const originalListen = stockfish.listen;
            stockfish.listen = (line: string) => {
                console.log('Stockfish:', line);

                // Parse depth info for progress updates
                if (line.startsWith('info') && line.includes('depth')) {
                    const depthMatch = line.match(/depth (\d+)/);
                    if (depthMatch) {
                        const currentDepth = parseInt(depthMatch[1]);
                        const progress = Math.min((currentDepth / targetDepth) * 100, 100);
                        updateComputerMoveProgress(progress);
                    }
                }

                // Handle best move
                if (line.startsWith('bestmove')) {
                    const move = line.split(' ')[1];
                    stockfish.listen = originalListen;
                    resolve(move);
                }
            };
        });

        stockfish.uci('go depth ' + targetDepth);
        const bestMove = await movePromise;

        // Convert UCI move to chess.js format and make the move
        const move = game.move({
            from: bestMove.substring(0, 2),
            to: bestMove.substring(2, 4),
            promotion: bestMove.length > 4 ? bestMove[4] : undefined
        });

        if (move) {
            // Decrement the computer move count for the current player
            if (currentPlayer === 'w') {
                whiteMovesRemaining--;
            } else {
                blackMovesRemaining--;
            }

            // Start the clock after first move (including computer moves)
            if (game.history().length === 1) {
                startClock();
            }

            // Add time increment for computer move
            addTimeIncrement();

            board.position(game.fen());
            updateStatus();
            updateClockDisplay();
            highlightKingInCheck();
        }

    } catch (error) {
        console.error('Computer move failed:', error);
    } finally {
        resetComputerMoveButton();
    }
}

function showOptions(): void {
    // Update the options modal with current values
    $('#blackMinutes').text(optionsState.blackMinutes);
    $('#blackIncrement').text(optionsState.blackIncrement);
    $('#whiteMinutes').text(optionsState.whiteMinutes);
    $('#whiteIncrement').text(optionsState.whiteIncrement);
    $('#blackComputerMoves').text(optionsState.blackComputerMoves);
    $('#whiteComputerMoves').text(optionsState.whiteComputerMoves);

    // Show the options modal
    $('#optionsModal').show();
}

function closeOptions(): void {
    $('#optionsModal').hide();
}

function adjustTime(player: string, type: string, delta: number): void {
    const key = `${player}${type.charAt(0).toUpperCase() + type.slice(1)}` as keyof typeof optionsState;
    let currentValue = optionsState[key];

    if (type === 'minutes') {
        // Minutes can go from 1 to 10
        currentValue = Math.max(1, Math.min(10, currentValue + delta));
    } else if (type === 'increment') {
        // Increment can go from 0 to 5
        currentValue = Math.max(0, Math.min(5, currentValue + delta));
    }

    optionsState[key] = currentValue;

    // Update the display
    $(`#${player}${type.charAt(0).toUpperCase() + type.slice(1)}`).text(currentValue);
}

function setPreset(minutes: number, increment: number): void {
    // Set both players to the same time control
    optionsState.whiteMinutes = minutes;
    optionsState.whiteIncrement = increment;
    optionsState.blackMinutes = minutes;
    optionsState.blackIncrement = increment;

    // Update all displays
    $('#whiteMinutes').text(minutes);
    $('#whiteIncrement').text(increment);
    $('#blackMinutes').text(minutes);
    $('#blackIncrement').text(increment);
}

function adjustComputerMoves(player: string, delta: number): void {
    const key = `${player}ComputerMoves` as keyof typeof optionsState;
    let currentValue = optionsState[key];
    currentValue = Math.max(0, Math.min(5, currentValue + delta));
    optionsState[key] = currentValue;

    // Update the display
    $(`#${player}ComputerMoves`).text(currentValue);
}

function saveAndStartGame(): void {
    // Apply the new time controls and computer move settings
    whiteTimeMs = optionsState.whiteMinutes * 60000;
    blackTimeMs = optionsState.blackMinutes * 60000;
    whiteIncrementMs = optionsState.whiteIncrement * 1000;
    blackIncrementMs = optionsState.blackIncrement * 1000;
    whiteMovesRemaining = optionsState.whiteComputerMoves;
    blackMovesRemaining = optionsState.blackComputerMoves;

    // Close options modal
    closeOptions();

    // Start a new game with the new settings
    confirmNewGame();
}

// Make functions available globally
(window as any).newGame = newGame;
(window as any).closeModalAndNewGame = closeModalAndNewGame;
(window as any).makeComputerMove = makeComputerMove;
(window as any).showOptions = showOptions;
(window as any).closeOptions = closeOptions;
(window as any).adjustTime = adjustTime;
(window as any).setPreset = setPreset;
(window as any).adjustComputerMoves = adjustComputerMoves;
(window as any).saveAndStartGame = saveAndStartGame;
(window as any).analyzeGame = analyzeGame;
(window as any).showGameArchive = showGameArchive;
(window as any).closeGameArchive = closeGameArchive;

// Prevent any scrolling on the entire document
function preventScroll(e: Event): void {
    // Allow touch events on the chess board for piece dragging
    const target = e.target as HTMLElement;
    if (target && (target.closest('#myBoard') || target.closest('.archive-list'))) {
        return; // Allow chess board interactions and archive scrolling
    }

    e.preventDefault();
    e.stopPropagation();
    return;
}

// Disable scrolling completely
function disableScroll(): void {
    // Prevent scroll events but allow chess board interactions
    document.addEventListener('wheel', preventScroll, { passive: false });
    document.addEventListener('touchmove', preventScroll, { passive: false });
    document.addEventListener('scroll', preventScroll, { passive: false });

    // Prevent window scrolling
    window.addEventListener('scroll', preventScroll, { passive: false });

    // Prevent touchmove on window but not chess board or archive
    window.addEventListener('touchmove', function (e) {
        const target = e.target as HTMLElement;
        if (!target || (!target.closest('#myBoard') && !target.closest('.archive-list'))) {
            e.preventDefault();
        }
    }, { passive: false });

    // Prevent keyboard scrolling
    document.addEventListener('keydown', function (e) {
        const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '];
        if (keys.includes(e.key)) {
            e.preventDefault();
        }
    });
}

// Initialize when DOM is ready
$(async function () {
    disableScroll();

    await loadChessboard();
    initializeChess();

    // Set up download dialog event listeners
    const downloadBtn = document.getElementById('downloadBtn');
    const cancelDownloadBtn = document.getElementById('cancelDownloadBtn');

    if (downloadBtn) {
        downloadBtn.addEventListener('click', () => {
            downloadAllNnueFiles();
        });
    }

    if (cancelDownloadBtn) {
        cancelDownloadBtn.addEventListener('click', () => {
            hideDownloadDialog();
        });
    }

    // Initialize Stockfish in the background.
    setTimeout(loadStockfish, 100);
});

