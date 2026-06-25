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

// Les dimensions sont maintenant dynamiques

const TILE_EMPTY = 0;
const TILE_WALL = 1;
const TILE_BLOCK = 2;

function getRandomSafeSpawns(width, height, numTeams) {
    const spawns = [];
    const minDistance = 5; 
    let attempts = 0;

    while (spawns.length < numTeams && attempts < 1000) {
        // Coordonnées impaires pour éviter les piliers
        const x = Math.floor(Math.random() * ((width - 2) / 2)) * 2 + 1;
        const y = Math.floor(Math.random() * ((height - 2) / 2)) * 2 + 1;
        
        let safe = true;
        for (const s of spawns) {
            const dist = Math.abs(s.x - x) + Math.abs(s.y - y);
            if (dist < minDistance) {
                safe = false;
                break;
            }
        }
        
        if (safe) {
            spawns.push({x, y});
        }
        attempts++;
    }
    
    // Fallback si pas assez de place
    while(spawns.length < numTeams) {
        const x = Math.floor(Math.random() * ((width - 2) / 2)) * 2 + 1;
        const y = Math.floor(Math.random() * ((height - 2) / 2)) * 2 + 1;
        spawns.push({x, y});
    }
    
    return spawns;
}

function generateMap(width, height, spawns) {
    const grid = [];
    for (let y = 0; y < height; y++) {
        const row = [];
        for (let x = 0; x < width; x++) {
            // Murs extérieurs
            if (y === 0 || y === height - 1 || x === 0 || x === width - 1) {
                row.push(TILE_WALL);
            }
            // Murs indestructibles internes (motif quadrillage)
            else if (y % 2 === 0 && x % 2 === 0) {
                row.push(TILE_WALL);
            }
            // Murs destructibles (gâteaux/biscuits)
            else {
                row.push(TILE_BLOCK);
            }
        }
        grid.push(row);
    }
    
    // Dégager les zones de spawn
    for (let i = 0; i < spawns.length; i++) {
        const spawn = spawns[i];
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = spawn.x + dx;
                const ny = spawn.y + dy;
                if (nx > 0 && nx < width - 1 && ny > 0 && ny < height - 1) {
                    if (grid[ny][nx] !== TILE_WALL) {
                         grid[ny][nx] = TILE_EMPTY;
                    }
                }
            }
        }
    }
    
    // Rendre quelques blocs vides aléatoirement
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            if (grid[y][x] === TILE_BLOCK && Math.random() >= 0.6) {
                grid[y][x] = TILE_EMPTY;
            }
        }
    }

    return grid;
}

function triggerExplosion(room, cx, cy) {
    const grid = room.gameState.grid;
    const width = room.gameState.width;
    const height = room.gameState.height;
    const directions = [ {dx:1,dy:0}, {dx:-1,dy:0}, {dx:0,dy:1}, {dx:0,dy:-1} ];
    const explosionCells = [{x: cx, y: cy}];

    checkExplosionHit(room, cx, cy);

    directions.forEach(dir => {
        // Boucle limitée à 1 pour une explosion d'une seule case (au lieu de 2)
        for (let i = 1; i <= 1; i++) {
            const nx = cx + dir.dx * i;
            const ny = cy + dir.dy * i;
            
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
            if (grid[ny][nx] === TILE_WALL) break;
            
            explosionCells.push({x: nx, y: ny});
            checkExplosionHit(room, nx, ny);
            
            if (grid[ny][nx] === TILE_BLOCK) {
                grid[ny][nx] = TILE_EMPTY; // Détruit le bloc
                room.gameState.destroyingBlocks.push({ x: nx, y: ny, time: Date.now() });
                // 20% de chance d'apparition d'un item
                if (Math.random() < 0.2) {
                    if (Math.random() < 0.5) {
                        room.gameState.items.push({ x: nx, y: ny, type: 'shield' });
                    } else {
                        const donutType = Math.floor(Math.random() * 3) + 1;
                        const pairId = Date.now().toString() + Math.random().toString();
                        
                        room.gameState.items.push({ x: nx, y: ny, type: `donuts${donutType}`, pairId: pairId });
                        
                        const emptyCells = [];
                        for (let y = 0; y < room.gameState.height; y++) {
                            for (let x = 0; x < room.gameState.width; x++) {
                                if (room.gameState.grid[y][x] === TILE_EMPTY) {
                                    const hasItem = room.gameState.items.some(i => i.x === x && i.y === y);
                                    if (!hasItem && (x !== nx || y !== ny)) emptyCells.push({x, y});
                                }
                            }
                        }
                        
                        if (emptyCells.length > 0) {
                            const dest = emptyCells[Math.floor(Math.random() * emptyCells.length)];
                            room.gameState.items.push({ x: dest.x, y: dest.y, type: `donuts${donutType}`, pairId: pairId });
                        }
                    }
                }
                break; // Stoppe l'explosion dans cette direction
            }
        }
    });

    room.gameState.explosions.push({ cells: explosionCells, time: Date.now() });
    io.to(room.screenId).emit('playSound', 'explosion');
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
    if (!room || (room.gameState.status !== 'playing' && room.gameState.status !== 'starting')) return;
    
    const now = Date.now();
    
    if (room.gameState.status === 'starting') {
        const remaining = Math.ceil((room.gameState.countdownEndTime - now) / 1000);
        if (remaining <= 0) {
            room.gameState.status = 'playing';
            room.lastSwitchTime = now;
            room.gameStartTime = now;
        } else {
            room.gameState.countdown = remaining;
        }
        io.to(room.screenId).emit('gameState', room.gameState);
        return;
    }
    
    // Calculate timers for HUD
    const playingTime = now - room.gameStartTime;
    const TIME_BEFORE_SHRINK = 45000; // 45 secondes
    
    room.gameState.timeToSwitch = Math.max(0, Math.ceil((15000 - (now - room.lastSwitchTime)) / 1000));
    
    if (playingTime < TIME_BEFORE_SHRINK) {
        room.gameState.timeToShrink = Math.max(0, Math.ceil((TIME_BEFORE_SHRINK - playingTime) / 1000));
    } else {
        room.gameState.timeToShrink = 0;
        const s = room.gameState.shrink;
        
        if (!s.active) {
            s.active = true;
            s.nextDropTime = now;
        }

        if (now >= s.nextDropTime) {
            if (s.minX <= s.maxX && s.minY <= s.maxY) {
                // Poser un mur indestructible
                room.gameState.grid[s.y][s.x] = TILE_WALL;
                
                // Tuer les joueurs sur cette case
                Object.keys(room.gameState.entities).forEach(teamId => {
                    const entity = room.gameState.entities[teamId];
                    if (!entity.dead && entity.x === s.x && entity.y === s.y) {
                        entity.dead = true;
                    }
                });
                
                // Détruire objets et bombes
                room.gameState.bombs = room.gameState.bombs.filter(b => b.x !== s.x || b.y !== s.y);
                room.gameState.items = room.gameState.items.filter(i => i.x !== s.x || i.y !== s.y);

                // Calculer la prochaine case de la spirale
                let nx = s.x + s.dx;
                let ny = s.y + s.dy;

                if (s.dx === 1 && nx > s.maxX) {
                    s.dx = 0; s.dy = 1; s.minY++; // Ligne du haut finie
                    nx = s.x; ny = s.y + 1;
                } else if (s.dy === 1 && ny > s.maxY) {
                    s.dx = -1; s.dy = 0; s.maxX--; // Colonne droite finie
                    nx = s.x - 1; ny = s.y;
                } else if (s.dx === -1 && nx < s.minX) {
                    s.dx = 0; s.dy = -1; s.maxY--; // Ligne du bas finie
                    nx = s.x; ny = s.y - 1;
                } else if (s.dy === -1 && ny < s.minY) {
                    s.dx = 1; s.dy = 0; s.minX++; // Colonne gauche finie
                    nx = s.x + 1; ny = s.y;
                }

                s.x = nx;
                s.y = ny;
                s.nextDropTime = now + 250; // 1 bloc toutes les 0.25s
            }
        }
    }
    
    // Nettoyage des explosions obsolètes (affichage de 500ms)
    room.gameState.explosions = room.gameState.explosions.filter(exp => now - exp.time < 500);

    // Nettoyage des blocs en destruction (affichage de 500ms)
    if (room.gameState.destroyingBlocks) {
        room.gameState.destroyingBlocks = room.gameState.destroyingBlocks.filter(block => now - block.time < 500);
    }

    // Vérification des bombes à faire exploser (3 secondes de timer)
    room.gameState.bombs = room.gameState.bombs.filter(bomb => {
        if (now - bomb.placedAt >= 3000) {
            triggerExplosion(room, bomb.x, bomb.y);
            return false;
        }
        return true;
    });

    // Expiration des boucliers (15 secondes)
    Object.keys(room.gameState.entities).forEach(teamId => {
        const entity = room.gameState.entities[teamId];
        if (entity.hasShield && entity.shieldEndTime && now > entity.shieldEndTime) {
            entity.hasShield = false;
            entity.shieldEndTime = null;
        }
    });

    // Vérifier s'il y a un gagnant
    checkWinCondition(room);

    // Logique de switch toutes les 15 secondes
    if (now - room.lastSwitchTime >= 15000) {
        room.lastSwitchTime = now;
        io.to(room.screenId).emit('playSound', 'switch');
        
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
                width: 15,
                height: 15,
                grid: [],
                entities: {},
                bombs: [],
                items: [],
                explosions: [],
                destroyingBlocks: []
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
            const numTeams = Object.keys(room.teams).length;
            if (numTeams === 0) return; // Ne pas lancer sans joueur

            const size = Math.min(11 + (numTeams * 4), 31);
            const width = size;
            const height = size;

            const spawns = getRandomSafeSpawns(width, height, numTeams);

            room.gameState.status = 'starting';
            room.gameState.countdown = 10;
            room.gameState.countdownEndTime = Date.now() + 10000;
            room.gameState.timeToShrink = 45;
            room.gameState.timeToSwitch = 15;
            room.gameState.shrink = {
                active: false,
                nextDropTime: 0,
                x: 1,
                y: 1,
                dx: 1,
                dy: 0,
                minX: 1,
                maxX: width - 2,
                minY: 1,
                maxY: height - 2
            };
            room.gameState.width = width;
            room.gameState.height = height;
            room.gameState.grid = generateMap(width, height, spawns);
            room.gameState.bombs = [];
            room.gameState.items = [];
            room.gameState.explosions = [];
            room.gameState.destroyingBlocks = [];
            room.gameState.winner = null;
            
            // Initialisation de la position des équipes (1 perso par équipe)
            let spawnIndex = 0;
            Object.keys(room.teams).forEach((teamId) => {
                const spawn = spawns[spawnIndex % spawns.length];
                room.gameState.entities[teamId] = {
                    name: teamId, // Store the team name
                    x: spawn.x,
                    y: spawn.y,
                    direction: 'bottom',
                    activePlayerIndex: 1,
                    dead: false,
                    hasShield: false,
                    lastBombTime: 0
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

    // Retourner au lobby depuis l'écran de fin
    socket.on('returnToLobby', (roomCode) => {
        const room = lobbies[roomCode];
        if (room && room.screenId === socket.id) {
            room.gameState.status = 'lobby';
            room.players = [];
            room.teams = {};
            room.gameState.entities = {};
            room.gameState.grid = [];
            room.gameState.bombs = [];
            room.gameState.items = [];
            room.gameState.explosions = [];
            room.gameState.destroyingBlocks = [];
            room.gameState.winner = null;
            if (room.gameInterval) clearInterval(room.gameInterval);
            
            io.to(roomCode).emit('resetLobby');
            io.to(room.screenId).emit('playerJoined', { players: [] });
            
            // Broadcast empty teams
            io.to(roomCode).emit('roomInfo', { teams: [] });
            
            console.log(`Lobby ${roomCode} réinitialisé`);
        }
    });

    // Envoyer les infos de la salle pour le choix d'équipe
    socket.on('getRoomInfo', (roomCode) => {
        const room = lobbies[roomCode];
        if (room) {
            socket.join(roomCode); // Join to receive broadcasts while browsing lobby
            const teamInfos = [];
            for (const teamId in room.teams) {
                teamInfos.push({
                    name: teamId,
                    count: room.teams[teamId].length,
                    players: room.teams[teamId].map(p => p.name)
                });
            }
            socket.emit('roomInfo', { teams: teamInfos });
        } else {
            socket.emit('error', 'Lobby introuvable.');
        }
    });

    // Un joueur mobile rejoint un lobby
    socket.on('joinLobby', ({ roomCode, playerName, teamName }) => {
        const room = lobbies[roomCode];
        if (room) {
            socket.join(roomCode);
            
            let assignedTeam = teamName;
            let teamPlayerIndex = 1;
            
            if (!room.teams[assignedTeam]) {
                room.teams[assignedTeam] = [];
            } else if (room.teams[assignedTeam].length >= 2) {
                socket.emit('error', 'Cette équipe est déjà complète.');
                return;
            } else {
                teamPlayerIndex = 2;
            }
            
            const newPlayer = {
                id: socket.id,
                name: playerName || `Joueur ${socket.id.substring(0,4)}`,
                team: assignedTeam,
                playerNumber: teamPlayerIndex,
                hasDefused: false
            };
            
            room.teams[assignedTeam].push(newPlayer);
            room.players.push(newPlayer);

            socket.emit('joined', {
                roomCode,
                team: assignedTeam,
                playerNumber: teamPlayerIndex
            });
            
            // Broadcast the new team state to everyone in the room
            const teamInfos = [];
            for (const teamId in room.teams) {
                teamInfos.push({
                    name: teamId,
                    count: room.teams[teamId].length,
                    players: room.teams[teamId].map(p => p.name)
                });
            }
            io.to(roomCode).emit('roomInfo', { teams: teamInfos });
            
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
            let newDir = teamEntity.direction;
            
            if (direction === 'up') { dy = -1; newDir = 'top'; }
            if (direction === 'down') { dy = 1; newDir = 'bottom'; }
            if (direction === 'left') { dx = -1; newDir = 'left'; }
            if (direction === 'right') { dx = 1; newDir = 'right'; }

            teamEntity.direction = newDir;

            const newX = teamEntity.x + dx;
            const newY = teamEntity.y + dy;

            // Logique de collision stricte Serveur
            if (newX >= 0 && newX < room.gameState.width && newY >= 0 && newY < room.gameState.height) {
                if (room.gameState.grid[newY][newX] === TILE_EMPTY) {
                    // Empêcher de marcher sur une bombe ou un autre joueur
                    const isBomb = room.gameState.bombs.some(b => b.x === newX && b.y === newY);
                    const isPlayer = Object.keys(room.gameState.entities).some(id => id !== player.team && !room.gameState.entities[id].dead && room.gameState.entities[id].x === newX && room.gameState.entities[id].y === newY);
                    
                    if (!isBomb && !isPlayer) {
                        teamEntity.x = newX;
                        teamEntity.y = newY;

                        // Vérifier si un item est présent
                        const itemIndex = room.gameState.items.findIndex(i => i.x === newX && i.y === newY);
                        if (itemIndex !== -1) {
                            const item = room.gameState.items[itemIndex];
                            
                            if (item.type === 'shield') {
                                room.gameState.items.splice(itemIndex, 1);
                                teamEntity.hasShield = true;
                                teamEntity.shieldEndTime = Date.now() + 15000; // 15 secondes
                            } else if (item.type.startsWith('donuts')) {
                                const otherItem = room.gameState.items.find(i => i.pairId === item.pairId && i !== item);
                                
                                room.gameState.items = room.gameState.items.filter(i => i.pairId !== item.pairId);
                                
                                if (otherItem) {
                                    teamEntity.x = otherItem.x;
                                    teamEntity.y = otherItem.y;
                                }
                                io.to(room.screenId).emit('playSound', 'pickup');
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
            const now = Date.now();
            const playingTimeMs = now - room.gameStartTime;
            const reductions = Math.floor(playingTimeMs / 15000); // 1 intervalle toutes les 15s
            const currentCooldown = Math.max(5000 - (reductions * 1000), 1500); // Commence à 5s, baisse de 1s, min 1.5s
            
            if (now - teamEntity.lastBombTime >= currentCooldown) {
                // Poser une bombe (max 1 par case)
                const exists = room.gameState.bombs.some(b => b.x === teamEntity.x && b.y === teamEntity.y);
                if (!exists) {
                    teamEntity.lastBombTime = now;
                    room.gameState.bombs.push({
                        x: teamEntity.x,
                        y: teamEntity.y,
                        teamId: player.team,
                        placedAt: now
                    });
                    
                    // Notifier l'équipe du cooldown
                    room.players.forEach(p => {
                        if (p.team === player.team) {
                            io.to(p.id).emit('cooldown', { type: 'bomb', duration: currentCooldown });
                        }
                    });
                }
            }
        } else if (type === 'blow') {
            if (!teamEntity.hasShield) {
                const blown = room.gameState.bombs.filter(b => b.team !== player.team);
                if (blown.length > 0) {
                    room.gameState.bombs = room.gameState.bombs.filter(b => b.team === player.team);
                    io.to(room.screenId).emit('playSound', 'blow');
                    io.to(player.id).emit('cooldown', { type: 'blow', duration: 10000 });
                    teamEntity.lastBlowTime = now;
                }
            }
        } else if (type === 'defuse') {
            if (!player.hasDefused) {
                // Désamorcer une bombe sur la case ou à une case de distance
                const bombIndex = room.gameState.bombs.findIndex(b => 
                    (Math.abs(b.x - teamEntity.x) <= 1 && b.y === teamEntity.y) ||
                    (Math.abs(b.y - teamEntity.y) <= 1 && b.x === teamEntity.x)
                );
                if (bombIndex !== -1) {
                    room.gameState.bombs.splice(bombIndex, 1);
                    player.hasDefused = true;
                    // Notifier le joueur
                    io.to(player.id).emit('actionConsumed', { type: 'defuse' });
                }
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Utilisateur déconnecté:', socket.id);
        
        for (const roomCode in lobbies) {
            const room = lobbies[roomCode];
            
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const player = room.players[playerIndex];
                room.players.splice(playerIndex, 1);
                
                if (room.teams[player.team]) {
                    room.teams[player.team] = room.teams[player.team].filter(p => p.id !== socket.id);
                    
                    if (room.teams[player.team].length === 0) {
                        if (room.gameState.status === 'lobby' || room.gameState.status === 'gameover') {
                            delete room.teams[player.team];
                        } else if (room.gameState.entities[player.team]) {
                            // L'équipe entière a quitté en pleine partie
                            room.gameState.entities[player.team].dead = true;
                        }
                    } else if (room.gameState.entities[player.team]) {
                        // Il reste un joueur, on lui donne le contrôle permanent pour éviter le tour fantôme
                        const remainingPlayer = room.teams[player.team][0];
                        room.gameState.entities[player.team].activePlayerIndex = remainingPlayer.playerNumber;
                        io.to(remainingPlayer.id).emit('turnUpdate', true);
                    }
                }
                
                if (room.gameState.status === 'lobby' || room.gameState.status === 'gameover') {
                    const teamInfos = [];
                    for (const teamId in room.teams) {
                        teamInfos.push({
                            name: teamId,
                            count: room.teams[teamId].length,
                            players: room.teams[teamId].map(p => p.name)
                        });
                    }
                    io.to(roomCode).emit('roomInfo', { teams: teamInfos });
                    io.to(room.screenId).emit('playerJoined', { players: room.players });
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur en écoute sur le port ${PORT}`);
});
