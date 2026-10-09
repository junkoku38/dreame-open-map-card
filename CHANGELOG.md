# Historique des versions

## v0.3.3
- **Chips → bouton actif** : sélectionner une pièce via sa pastille activait bien le surlignage mais laissait « Nettoyer la sélection » désactivé et « Tout désélect. » invisible — les boutons sont désormais reconstruits à chaque changement de sélection.
- **Rotation de la carte** : `size[7]` (rotation réglable via le sélecteur `map_rotation` de l'intégration) est désormais appliquée au rendu (90/180/270°, comme le renderer officiel), y compris le mapping inverse du pointeur et les étiquettes.
- **Pièces invisibles** : un clic sur la zone d'une pièce cachée (`visibility: false`) ou non cartographiée ne peut plus la sélectionner (elle serait partie au nettoyage sans être visible) ; son étiquette n'est plus dessinée.
- **Récupération réseau blindée** : jamais deux requêtes en vol (garde `_fetching` sur tous les chemins) et garde-fou de 20 s — une connexion qui traîne n'immobilise plus la carte.
- **Batterie** : l'icône n'est plus reconstruite à chaque poussée `hass` (signature de changement), retour propre après une valeur indisponible.
- **Hint « Aller à »** : texte aligné sur le comportement réel (un point).

## v0.3.2
- **Autocomplétion réparée** : remplacement du `<datalist>` natif (qui ne s'affiche pas dans un shadow DOM sous Chromium) par un dropdown maison — filtrage live, navigation clavier (flèches / Entrée / Échap), clic pour appliquer.
- Correctifs v0.3.1 reconduits : YAML existant préservé (`type`, `colors`…) dans `config-changed`, champ en cours de saisie non écrasé.

## v0.3.1
- Correctifs de l'éditeur : la config émise **préserve désormais tout le YAML existant** (type de carte, colors, segment_colors…) au lieu de le reconstruire — plus de prévisualisation cassée ni de clés perdues en sauvegardant.
- Le champ en cours de saisie n'est plus écrasé par les rappels setConfig de HA (curseur et saisie intacts).
- Les listes d'entités ne se reconstruisent plus à chaque mise à jour hass.

## v0.3.0
- **Éditeur visuel** : `getConfigElement` fournit un éditeur graphique (aspirateur et caméra avec autocomplétion sur les entités réelles via datalist, titre, intervalle, 7 bascules) qui n'émet que les valeurs non par défaut (`config-changed`).
- **Design revu** : en-tête avec badge d'icône robot et sous-ligne état/batterie, sélecteur de mode segmenté, pièces en pastilles arrondies teintées, boutons d'action à coins arrondis avec survol/activé, carte encadrée à coins arrondis, ligne « maj il y a » épurée.
- Accessibilité : `:focus-visible` sur les contrôles, `prefers-reduced-motion` respecté.

## v0.2.1
- Batterie désormais fiable sur dreame-vacuum : attribut standard `battery_level` avec repli sur `battery` (seul attribut exposé par l'intégration) ; icônes mdi graduées (charge, niveaux, rouge sous 20 %).
- `getStubConfig` : pré-remplissage automatique de la configuration dans l'éditeur (aspirateur + caméra assortie).
- `getGridOptions` : pleine largeur annoncée aux nouvelles grilles Lovelace.

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