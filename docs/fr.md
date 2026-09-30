# Orbit B-hyve pour Gladys

Pilote les programmateurs d'arrosage Wi-Fi Orbit B-hyve via le cloud B-hyve, avec
la même API et le même flux d'événements que l'application B-hyve.

## Fonctionnalités (par programmateur)

- **Arrosage <zone>** — un interrupteur par zone. Allumé, il arrose la zone pendant
  la *Durée* en cours ; éteint, il arrête l'arrosage.
- **Durée** — minutes d'arrosage d'une zone allumée (1 à 120, 10 par défaut).
- **Report pluie** — heures de suspension des programmes (0 à 168 ; 0 annule).
- **Prochain arrosage** — le prochain démarrage prévu et son programme.
- **Défaut** — `OK`, ou les défauts de zone signalés par le programmateur.

## Scènes

- **Déclencheurs :** arrosage démarré, arrosage terminé (filtre par nom de
  zone), défaut de zone, défaut résolu.
- **Actions :** arroser une zone pendant N minutes, arrêter l'arrosage, régler
  un report pluie.

Un arrosage lancé par le programme du programmateur ou depuis l'application B-hyve
est reflété en direct via le flux d'événements.

## Configuration

Saisissez l'e-mail et le mot de passe de votre compte B-hyve, puis ouvrez l'onglet
Découverte et créez l'appareil.

## Dépannage

- *Connexion refusée* — vérifiez les identifiants dans l'application B-hyve.
- États en retard — le flux d'événements se reconnecte automatiquement ;
  l'intervalle de rafraîchissement sert de filet de sécurité.
- Journaux : `docker logs` sur le conteneur de l'intégration.
