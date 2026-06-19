# Contexte du Projet : BomberTime Web

## Résumé
BomberTime est un jeu massivement multijoueur (jusqu'à 200 joueurs) inspiré de Bomberman, sur le thème de la pâtisserie.
Le but est d'être la dernière équipe en vie.

## Architecture
**Serveur Autoritaire** (Node.js, Express, Socket.io) :
- Le backend (`index.js`) gère 100% de la logique physique, temporelle et des collisions. 
- La boucle de jeu ("Game Loop") tourne à 20 Ticks par seconde.
- L'état du jeu (Matrice de la map, positions, bombes, items) est envoyé en temps réel via WebSockets ("broadcast").

**Écran Principal / L'Amphi** (`public/index.html`) :
- C'est un client "bête" (Rendu pur).
- Affiche le code de la salle, le QR Code de connexion et la liste des joueurs.
- Une fois la partie lancée, il affiche un `<canvas>` HTML5 et redessine en temps réel l'état de la grille et des personnages.
- Les assets graphiques sont stockés dans `/public/asset/`.

**Les Manettes Mobiles** (`public/mobile.html`) :
- Les joueurs s'y connectent via le QR Code du lobby (qui auto-remplit l'URL `?room=ABCD`).
- Les téléphones envoient de simples "intentions" (move, action) grâce à une croix directionnelle tactile (`touchstart` / `touchend`).
- Un système de "Tour par Tour" bascule automatiquement le contrôle entre les membres d'une même équipe toutes les 15 secondes (la manette inactive se grise).

## État de l'Avancement
- [x] **Étape 1** : Scaffold Node.js, système de Lobby (Génération du code), Assignation automatique des joueurs en équipe de 2.
- [x] **Étape 2** : Matrice 2D, Mouvements de base validés par le serveur, Rendu Canvas.
- [x] **Étape 3** : D-Pad mobile (TouchEvents continus), système de tour de rôle toutes les 15s (grise les manettes via `turnUpdate`).
- [x] **Étape 4** : Logique des bombes-gâteaux (timer 3s, explosion en croix), destructions des blocs (`TILE_BLOCK`), élimination des joueurs, désamorçage ("💨"), et Items (Bouclier "Cyan", Portail TP "Violet" générés à 20% de chance). Détection du gagnant (Game Over et bouton relancer).
- [x] **Étape 5** : Fichier `render.yaml` créé pour le déploiement. Intégration des assets (spritesheet). Ajout du QR Code.

## Ce qu'il reste à implémenter (Notes pour les futures IAs)
1. **Battle Royale (Rétrécissement de la carte)** : La map doit se rétrécir en forme d'escargot (blocs indestructibles) au fil du temps pour forcer l'affrontement (Zone de "killzone").
2. **Peaufinage Visuel** : Utiliser la grille d'animation de `/public/asset/new_spritesheet.png` au lieu d'une image fixe pour les déplacements des personnages, et ajouter des animations pour les explosions.
3. **Ambiance Sonore** : Intégrer les sons côté Canvas (musique rétro, bruit d'explosion, cloche de changement de tour).
4. **Interface** : Afficher les scores ou les timers de bombes directement sur les cases de l'écran principal.
