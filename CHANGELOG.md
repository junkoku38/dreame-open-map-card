# Historique des versions

## v0.2.0
- `update_interval` : normalisation stricte (les booléens, négatifs et non numériques retombent sur le défaut 5 ; chaînes numériques acceptées ; borné 1–120).
- Canvas : `aria-label` renseigné avec le nom réel de l'aspirateur.
- 15 configurations exotiques testées (aucun throw, aucune injection via le titre).

## v0.1.9
- Message d'erreur du fetch raccourci ; détails techniques en console (option `debug: true` pour les afficher dans la carte).
- Fallback de grille aligné sur le protocole (50 mm/pixel).

## v0.1.8
- Identifiants de couches pixels alignés sur `MapPixelType` de l'intégration : sol = 254, obstacles muraux = 251 ; `OUTSIDE(0)`, couches wifi (2–14), 249/250/252/253 ignorées.
- Suppression du code mort : les tapis sont des quads (aucune couche pixel 512 n'existe), pas de plage 201..231.
- Couleurs de tapis personnalisables (`colors.carpet` / `colors.carpetStroke`).

## v0.1.7
- Rendu HiDPI : backing store ×devicePixelRatio (capé ×2), repère logique et interactions inchangés.

## v0.1.6
- `color_index` absent (null) n'est plus lu comme 0 : chaque pièce garde sa couleur.
- `Number.isFinite` sur les index de couleur ; sélection élaguée des segments devenus inconnus ; 30 cas de données dégradées testés.

## v0.1.5
- Zones/points en attente effacés au changement de mode (plus d'affichages zombies).
- « Nettoyer la sélection », « Aller au point », « Suivre le chemin » désactivés tant que rien n'est sélectionné.
- Noms de pièces longs tronqués proprement (ellipsis + infobulle) ; `user-select` désactivé sur les contrôles.

## v0.1.4
- Sémantique `color_index` : l'index 0 est valide (les pièces ne fusionnent plus leurs couleurs) ; permutation [0,2,3,1] pour les cartes version 3.
- Segments masqués (`visibility=false`) exclus du rendu, des pastilles et de la sélection.
- Couleurs par instance ; messages d'attente neutres ; fetch suspendu onglet caché ; `update_interval` borné ; `role="img"` sur le canvas.

## v0.1.3
- Pastilles triées par ordre de pièce, murs/contours épaissis, marqueur robot/dock fusionné, message d'erreur de fetch conservé correctement.

## v0.1.2
- Diagnostic réseau (cascade fetch → callApi, classification HTTP/auth/décodage) ; garde shadowRoot durcie.

## v0.1.1
- Rendu de la couche murs (255) ; bannière de version.

## v0.1.0
- Première version publique : rendu de la carte, sélection de pièces, nettoyage de zone, aller à, suivi de chemin, boutons aspirateur.