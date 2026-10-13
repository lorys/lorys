# Prospection

Petit outil de suivi de prospection terrain (porte-à-porte) : une liste de cibles (commerces), un onglet par commercial avec sa prochaine cible, l'itinéraire Google Maps et l'historique des échanges.

Serveur Node.js (Fastify) + MongoDB, front en HTML/CSS/JS sans framework.

## Lancer

```sh
npm install
cp .env.example .env   # puis renseigner PASSWORD et MONGODB_URI
npm start              # http://localhost:3000
```

| Variable      | Rôle                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `PASSWORD`    | Mot de passe unique d'accès. Le changer déconnecte tout le monde.    |
| `MONGODB_URI` | Base MongoDB. Sans nom de base dans l'URI, la base `prospection` est utilisée. |
| `PORT`, `HOST`| Optionnels (`3000`, `0.0.0.0`).                                       |

La session dure un mois (cookie `httpOnly`, signé HMAC).

## Fonctionnement

- **Cibles** : toutes les cibles, bouton *Ajouter* (nom, lien Google Maps, commercial, date prévue du 1er échange) et bouton 👁 pour ouvrir la fiche. L'adresse est déduite du lien Maps quand elle n'est pas saisie (les liens courts `maps.app.goo.gl` sont suivis).
- **Onglet d'un commercial** (bouton `+` pour en créer un) :
  - *Prochaine cible* : sa cible ouverte avec la date prévue la plus proche, bouton *Itinéraire*, ⚙ pour modifier (dont le statut : à démarcher, en cours, gagné, perdu).
  - *Historique* : ⊕ ajoute une note datée et permet de fixer la date du prochain échange. La première note fait passer la cible « en cours ».
  - *Prochains prospects* : les autres cibles ouvertes, triées par date ; un clic l'affiche en haut.
  - *Rechercher…* : dans toutes ses cibles, y compris gagnées/perdues.

## Tests

```sh
npm test
# Avec le test d'intégration de l'API (la base est vidée !) :
TEST_MONGODB_URI=mongodb://127.0.0.1:27017/prospection_test npm test
```
