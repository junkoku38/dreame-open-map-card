# Dreame Open Map Card

Carte interactive pour l'intégration Home Assistant
[Tasshack/dreame-vacuum](https://github.com/Tasshack/dreame-vacuum) — **open source (MIT), sans clé de licence**.

> ⚠️ Projet **indépendant**, non affilié à Tasshack ni Dreame. Aucune « Dreame
> Vacuum Card » (DVC) ni clé `dvc_key` n'est nécessaire. Seule l'interface
> publique de l'intégration MIT est utilisée : l'entité `camera.map_data`
> (service `/api/camera_map_data_proxy/{entity_id}`) et les services standard
> de l'intégration.

## Fonctionnalités

- Rendu de la carte en direct **dans le navigateur** (aucun rendu côté serveur) :
  sols, pièces, murs, tapis, trajectoire, position et orientation du robot, chargeur,
  zones interdites, murs virtuels, marquage des segments activés.
- Nettoyage de **pièces** : sélection au clic sur la carte ou sur les pastilles
  (noms des pièces décodés automatiquement) → `dreame_vacuum.vacuum_clean_segment`.
- Nettoyage de **zone** : dessine des rectangles → `vacuum_clean_zone`.
- **Aller à** : pose un point → `vacuum_goto`.
- **Chemin** : relie des points → `vacuum_follow_path`.
- Contrôles : Nettoyer / Pause / Stop / Base / Localiser.
- Nombre de passes configurable (1–3).
- Auto-rafraîchissement adaptatif (plus fréquent pendant le nettoyage), cache-buster
  automatique, décompression gzip intégrée.

## Prérequis

1. L'intégration [dreame-vacuum](https://tasshack.github.io/dreame-vacuum/) installée et configurée (sans clé : laisse le champ `dvc_key` vide).
2. **Activer l'entité « Données cartographiques actuelles »** (`camera.*_map_data`) :
   Paramètres → Appareils et services → dreame_vacuum → entités désactivées → activer.
   C'est de cette entité que la carte lit les données brutes de la carte.

## Installation

### HACS (recommandé)

1. HACS → **Intégrations/Cartes personnalisées** → menu → *Dépôts personnalisés*
2. URL du dépôt : `https://github.com/junkoku38/dreame-open-map-card`, catégorie **Interface (Lovelace)**
3. Installer « Dreame Open Map Card ».
4. Paramètres → Tableaux de bord → Ressources : si HACS ne l'a pas offerte,
   ajouter `/hacsfiles/dreame-open-map-card/dreame-open-map-card.js` — type **Module JavaScript**.

### Manuel

Copier `dreame-open-map-card.js` dans `config/www/`, puis :

Paramètres → Tableaux de bord → Ressources → + Ressource :
`/local/dreame-open-map-card.js` — type **Module JavaScript**.

## Configuration

```yaml
type: custom:dreame-open-map-card
entity: vacuum.mon_dreame
camera: camera.mon_dreame_map_data
title: "Robot du salon"            # optionnel
update_interval: 5                 # rafraîchissement base, en s (1–120, défaut 5)
controls: true                     # boutons Nettoyer/Pause/Stop/Base/Localiser
room_cleaning: true
zone_cleaning: true
goto: true                         # mode "Aller à"
follow_path: false                 # mode "Suivre un chemin"
show_room_labels: true
# colors:                          # surcharges de couleurs (optionnel)
#   floor: "#ece9e1"
#   wall: "#9aa0a6"
# segment_colors:                  # palette des pièces (optionnel)
#   - "rgb(99, 181, 245)"
#   - "rgb(245, 183, 74)"
```

Champs requis : `entity` (aspirateur) et `camera` (l'entité `map_data`).

## Dépannage

| Symptôme | Solution |
| --- | --- |
| « Entité camera introuvable » | Activer l'entité *Données cartographiques actuelles* (elle est désactivée par défaut). |
| Carte vide | Lancer un nettoyage complet une fois pour que le robot produise la première carte. |
| Une pièce n'apparaît pas | Si la pièce a été rendue invisible dans l'app robot (visibilité désactivée), la carte la masque aussi, comme le renderer officiel. |
| Carte qui ne bouge pas | Recharger la page (F5) puis vérifier `update_interval`; le navigateur met `/api/...` en cache, la carte applique un cache-buster automatiquement. |
| Pastilles sans noms | Nommer les pièces dans l'app Mi Home / Dreamehome, puis forcer un `vacuum_reload_maps` (service de l'intégration). |

## Pourquoi ce projet ?

La carte officielle « Dreame Vacuum Card » est **payante et fermée** : elle
 exige une clé achetée par appareil et son code fonctionnel n'est distribué
ni dans le dépôt ni publiquement. Ce projet démontre qu'une carte complète
peut être **entièrement libre** en consommant les données publiques de
l'intégration — exactement comme la carte Valetudo Map Card officiellement
supportée par la documentation de l'intégration.

## Licence

[MIT](./LICENSE)