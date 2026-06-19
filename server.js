const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// État global des lobbies
const lobbies = {};

const MAP_WIDTH = 31;
const MAP_HEIGHT = 15;
const TILE_EMPTY = 0;
const TILE_WALL = 1;
const TILE_BLOCK = 2;

function generateMap() {
    const grid = [];
    for (let y = 0; y < MAP_HEIGHT; y++) {
        const row = [];
        for (let x = 0; x < MAP_WIDTH; x++) {
            // Murs extérieurs
            if (y === 0 || y === MAP_HEIGHT - 1 || x === 0 || x === MAP_WIDTH - 1) {
                row.push(TILE_WALL);
            }
            // Murs indestructibles internes (motif quadrillage)
            else if (y % 2 === 0 && x % 2 === 0) {
                row.push(TILE_WALL);
            }
            // Murs destructibles (gâteaux/biscuits)
            else {
                // Zone de spawn (coins) dégagée
                const isCorner = (x <= 2 && y <= 2) || 
                                 (x >= MAP_WIDTH - 3 && y <= 2) ||
                                 (x <= 2 && y >= MAP_HEIGHT - 3) ||
                                 (x >= MAP_WIDTH - 3 && y >= MAP_HEIGHT - 3);
                
                if (!isCorner && Math.random() < 0.6) {
                    row.push(TILE_BLOCK);
                } else {
                    row.push(TILE_EMPTY);
                }
            }
        }
        grid.push(row);
    }
    return grid;
}

function triggerExplosion(room, cx, cy) {
    const grid = room.gameState.grid;
    const directions = [ {dx:1,dy:0}, {dx:-1,dy:0}, {dx:0,dy:1}, {dx:0,dy:-1} ];
    const explosionCells = [{x: cx, y: cy}];

    checkExplosionHit(room, cx, cy);

    directions.forEach(dir => {
        // Boucle limitée à 1 pour une explosion d'une seule case (au lieu de 2)
        for (let i = 1; i <= 1; i++) {
            const nx = cx + dir.dx * i;
            const ny = cy + dir.dy * i;
            
            if (nx < 0 || nx >= MAP_WIDTH || ny < 0 || ny >= MAP_HEIGHT) break;
            if (grid[ny][nx] === TILE_WALL) break;
            
            explosionCells.push({x: nx, y: ny});
            checkExplosionHit(room, nx, ny);
            
            if (grid[ny][nx] === TILE_BLOCK) {
                grid[ny][nx] = TILE_EMPTY; // Détruit le bloc
                // 20% de chance d'apparition d'un item
                if (Math.random() < 0.2) {
                    room.gameState.items.push({
                        x: nx, y: ny,
                        type: Math.random() < 0.5 ? 'shield' : 'portal'
                    });
                }
                break; // Stoppe l'explosion dans cette direction
            }
        }
    });

    room.gameState.explosions.push({ cells: explosionCells, time: Date.now() });
}

function checkExplosionHit(room, x, y) {
    Object.keys(room.gameState.entities).forEach(teamId => {
        const entity = room.gameState.entities[teamId];
        if (!entity.dead && entity.x === x && entity.y === y) {
            if (entity.hasShield) {
                entity.hasShield = false; // Le bouclier absorbe l'explosion
            } else {
                entity.dead = true; // K.O.
            }
        }
    });
}

function checkWinCondition(room) {
    const aliveTeams = [];
    Object.keys(room.gameState.entities).forEach(teamId => {
        if (!room.gameState.entities[teamId].dead) {
            aliveTeams.push(teamId);
        }
    });

    const totalTeams = Object.keys(room.gameState.entities).length;
    if (totalTeams > 0) {
        if (aliveTeams.length === 0) {
            room.gameState.status = 'gameover';
            room.gameState.winner = "Égalité ! Tout le monde a explosé.";
        } else if (aliveTeams.length === 1 && totalTeams > 1) {
            room.gameState.status = 'gameover';
            const winningTeamId = aliveTeams[0];
            const winningPlayers = room.teams[winningTeamId].map(p => p.name).join(' & ');
            room.gameState.winner = `L'Équipe ${winningTeamId} (${winningPlayers}) a gagné !`;
        }
    }
}

function gameTick(roomCode) {
    const room = lobbies[roomCode];
    if (!room || room.gameState.status !== 'playing') return;
    
    const now = Date.now();
    
    // Nettoyage des explosions obsolètes (affichage de 500ms)
    room.gameState.explosions = room.gameState.explosions.filter(exp => now - exp.time < 500);

    // Vérification des bombes à faire exploser (3 secondes de timer)
    room.gameState.bombs = room.gameState.bombs.filter(bomb => {
        if (now - bomb.placedAt >= 3000) {
            triggerExplosion(room, bomb.x, bomb.y);
            return false;
        }
        return true;
    });

    // Vérifier s'il y a un gagnant
    checkWinCondition(room);

    // Logique de switch toutes les 15 secondes
    if (now - room.lastSwitchTime >= 15000) {
        room.lastSwitchTime = now;
        
        // Alterner le tour
        Object.keys(room.gameState.entities).forEach(teamId => {
            const entity = room.gameState.entities[teamId];
            const teamPlayers = room.teams[teamId];
            if (teamPlayers.length > 1) {
                entity.activePlayerIndex = entity.activePlayerIndex === 1 ? 2 : 1;
            }
        });
        
        // Mettre à jour les manettes
        room.players.forEach(p => {
            const teamEntity = room.gameState.entities[p.team];
            const isActive = (teamEntity.activePlayerIndex === p.playerNumber);
            io.to(p.id).emit('turnUpdate', isActive);
        });
    }

    // Broadcast l'état du jeu à l'écran principal
    io.to(room.screenId).emit('gameState', room.gameState);
}

function generateRoomCode() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 4; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

io.on('connection', (socket) => {
    console.log('Utilisateur connecté:', socket.id);

    // L'écran principal crée un lobby
    socket.on('createLobby', () => {
        const roomCode = generateRoomCode();
        lobbies[roomCode] = {
            screenId: socket.id,
            players: [],
            teams: {},
            nextTeamId: 1,
            gameState: {
                status: 'lobby',
                grid: [],
                entities: {},
                bombs: [],
                items: [],
                explosions: []
            },
            gameInterval: null
        };
        socket.join(roomCode);
        socket.emit('lobbyCreated', { roomCode });
        console.log(`Lobby créé: ${roomCode}`);
    });

    // L'écran principal lance ou relance la partie
    socket.on('startGame', (roomCode) => {
        const room = lobbies[roomCode];
        if (room && room.screenId === socket.id && (room.gameState.status === 'lobby' || room.gameState.status === 'gameover')) {
            room.gameState.status = 'playing';
            room.gameState.grid = generateMap();
            room.gameState.bombs = [];
            room.gameState.items = [];
            room.gameState.explosions = [];
            room.gameState.winner = null;
            
            // Initialisation de la position des équipes (1 perso par équipe)
            const spawns = [
                {x: 1, y: 1}, {x: MAP_WIDTH-2, y: 1},
                {x: 1, y: MAP_HEIGHT-2}, {x: MAP_WIDTH-2, y: MAP_HEIGHT-2}
            ];
            
            let spawnIndex = 0;
            Object.keys(room.teams).forEach((teamId) => {
                const spawn = spawns[spawnIndex % spawns.length];
                room.gameState.entities[teamId] = {
                    x: spawn.x,
                    y: spawn.y,
                    activePlayerIndex: 1,
                    dead: false,
                    hasShield: false
                };
                spawnIndex++;
            });
            
            room.lastSwitchTime = Date.now();

            // Avertir chaque joueur s'il est actif ou non au début
            room.players.forEach(p => {
                const teamEntity = room.gameState.entities[p.team];
                const isActive = (teamEntity.activePlayerIndex === p.playerNumber);
                io.to(p.id).emit('turnUpdate', isActive);
            });

            // Lancement de la Game Loop à ~20 ticks par seconde
            if (room.gameInterval) clearInterval(room.gameInterval);
            room.gameInterval = setInterval(() => {
                gameTick(roomCode);
            }, 1000 / 20);
            
            io.to(roomCode).emit('gameStarted');
            console.log(`Partie lancée dans le lobby ${roomCode}`);
        }
    });

    // Un joueur mobile rejoint un lobby
    socket.on('joinLobby', ({ roomCode, playerName }) => {
        const room = lobbies[roomCode];
        if (room) {
            socket.join(roomCode);
            
            // Assigner l'équipe (2 joueurs par équipe)
            let assignedTeam = null;
            let teamPlayerIndex = 1;
            
            // Chercher une équipe avec 1 seul joueur
            for (const teamId in room.teams) {
                if (room.teams[teamId].length < 2) {
                    assignedTeam = parseInt(teamId);
                    teamPlayerIndex = 2;
                    break;
                }
            }
            
            // Créer une nouvelle équipe si aucune n'est disponible
            if (!assignedTeam) {
                assignedTeam = room.nextTeamId++;
                room.teams[assignedTeam] = [];
                teamPlayerIndex = 1;
            }
            
            const newPlayer = {
                id: socket.id,
                name: playerName || `Joueur ${socket.id.substring(0,4)}`,
                team: assignedTeam,
                playerNumber: teamPlayerIndex
            };
            
            room.teams[assignedTeam].push(newPlayer);
            room.players.push(newPlayer);

            socket.emit('joined', {
                roomCode,
                team: assignedTeam,
                playerNumber: teamPlayerIndex
            });
            
            // Mettre à jour l'écran principal
            io.to(room.screenId).emit('playerJoined', {
                players: room.players
            });
            
            console.log(`Le joueur ${newPlayer.name} a rejoint la salle ${roomCode} (Equipe ${assignedTeam})`);
        } else {
            socket.emit('error', 'Lobby introuvable ou code invalide.');
        }
    });

    // Mouvement reçu depuis une manette
    socket.on('move', ({ roomCode, direction }) => {
        const room = lobbies[roomCode];
        if (!room || room.gameState.status !== 'playing') return;
        
        // Trouver le joueur
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const teamEntity = room.gameState.entities[player.team];
        if (!teamEntity || teamEntity.dead) return; // Un joueur mort ne peut plus bouger
        
        // Vérifier si c'est bien le tour de ce joueur dans l'équipe
        if (teamEntity.activePlayerIndex === player.playerNumber) {
            let dx = 0, dy = 0;
            if (direction === 'up') dy = -1;
            if (direction === 'down') dy = 1;
            if (direction === 'left') dx = -1;
            if (direction === 'right') dx = 1;

            const newX = teamEntity.x + dx;
            const newY = teamEntity.y + dy;

            // Logique de collision stricte Serveur
            if (newX >= 0 && newX < MAP_WIDTH && newY >= 0 && newY < MAP_HEIGHT) {
                if (room.gameState.grid[newY][newX] === TILE_EMPTY) {
                    // Empêcher de marcher sur une bombe (optionnel, mais typique de bomberman)
                    const isBomb = room.gameState.bombs.some(b => b.x === newX && b.y === newY);
                    if (!isBomb) {
                        teamEntity.x = newX;
                        teamEntity.y = newY;

                        // Vérifier si un item est présent
                        const itemIndex = room.gameState.items.findIndex(i => i.x === newX && i.y === newY);
                        if (itemIndex !== -1) {
                            const item = room.gameState.items[itemIndex];
                            room.gameState.items.splice(itemIndex, 1);
                            if (item.type === 'shield') {
                                teamEntity.hasShield = true;
                            } else if (item.type === 'portal') {
                                // TP aléatoire sur une case vide
                                const emptyCells = [];
                                for (let y = 0; y < MAP_HEIGHT; y++) {
                                    for (let x = 0; x < MAP_WIDTH; x++) {
                                        if (room.gameState.grid[y][x] === TILE_EMPTY) emptyCells.push({x, y});
                                    }
                                }
                                if (emptyCells.length > 0) {
                                    const dest = emptyCells[Math.floor(Math.random() * emptyCells.length)];
                                    teamEntity.x = dest.x;
                                    teamEntity.y = dest.y;
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    // Actions depuis une manette (Bombe, Désamorçage)
    socket.on('action', ({ roomCode, type }) => {
        const room = lobbies[roomCode];
        if (!room || room.gameState.status !== 'playing') return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const teamEntity = room.gameState.entities[player.team];
        if (!teamEntity || teamEntity.dead || teamEntity.activePlayerIndex !== player.playerNumber) return;

        if (type === 'bomb') {
            // Poser une bombe (max 1 par case)
            const exists = room.gameState.bombs.some(b => b.x === teamEntity.x && b.y === teamEntity.y);
            if (!exists) {
                room.gameState.bombs.push({
                    x: teamEntity.x,
                    y: teamEntity.y,
                    teamId: player.team,
                    placedAt: Date.now()
                });
            }
        } else if (type === 'defuse') {
            // Désamorcer une bombe sur la case ou à une case de distance
            const bombIndex = room.gameState.bombs.findIndex(b => 
                (Math.abs(b.x - teamEntity.x) <= 1 && b.y === teamEntity.y) ||
                (Math.abs(b.y - teamEntity.y) <= 1 && b.x === teamEntity.x)
            );
            if (bombIndex !== -1) {
                room.gameState.bombs.splice(bombIndex, 1);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Utilisateur déconnecté:', socket.id);
        // Gestion de la déconnexion (à affiner dans les prochaines étapes)
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur en écoute sur le port ${PORT}`);
});
