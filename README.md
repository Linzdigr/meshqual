# meshqual

Carte de qualité des liens MeshCore. Backend Go qui ingère le flux MQTT des
observateurs, frontend Vue 3 qui affiche les liens colorés par SNR avec les N
dernières trames par lien.

```
observateurs MeshCore ──MQTT──▶ relayd (Go) ──┬── table de liens en mémoire ──▶ /api/links (GeoJSON)
                                               ├── TimescaleDB ──────────────▶ /api/.../history
                                               └── hub SSE ──────────────────▶ /api/stream
                                                                                     │
                                                                          frontend Vue 3 + MapLibre
```

## Le point qui structure tout : à quoi se rattache un SNR

C'est la contrainte dont découle l'ensemble du modèle de données, et la raison
pour laquelle « colorer les liens entre répéteurs par leur SNR » ne veut pas dire
ce qu'on croit.

Dans le firmware MeshCore, le champ `path` d'un paquet ne contient **que des
hashs de routage** (1 à 4 octets par saut) — aucune mesure de signal
([`Dispatcher.cpp`][disp], [`Packet.h`][pkt]). Le SNR et le RSSI publiés par un
observateur sont ceux mesurés **par sa propre radio**, donc ils ne décrivent
qu'un seul lien : *dernier relais du chemin → observateur*.

Il en découle trois natures de lien, que l'application distingue partout :

| `kind` | Origine | SNR |
|---|---|---|
| `measured` | dernier saut → observateur | **réel**, mesuré par l'observateur |
| `trace` | paquet `PAYLOAD_TYPE_TRACE` : chaque relais ajoute son propre SNR (`path[n] = int8(snr*4)`, [`Mesh.cpp`][mesh]) | **réel**, par saut |
| `topology` | deux sauts adjacents dans un chemin observé | **aucun** — il n'existe pas |

Étaler le SNR de l'observateur sur tout le chemin produirait une carte sûre
d'elle et fausse. Les liens topologiques sont donc tracés en pointillés gris, sans
jamais emprunter un pas de la rampe de couleurs, et l'API ne renvoie pas de champ
`snrMedian` pour eux.

Conséquence pratique : sur un maillage jeune, la majorité des arêtes sont
`topology`. Le ratio est affiché en permanence dans la barre de statut
(`attribution X % / Y %` : hashs non résolus / hashs ambigus), parce qu'une carte
qui masque ça se lit comme une vérité alors qu'elle est surtout une déduction.

### Hashs ambigus

Un hash de chemin sur 1 octet n'a que 256 valeurs : sur quelques centaines de
nœuds, les collisions sont la norme. Un saut dont le hash correspond à plusieurs
nœuds connus **ne crée aucune arête** — il est compté, pas inventé.

## Stack et pourquoi

| Choix | Raison |
|---|---|
| **Go + `eclipse/paho.golang` (autopaho)** | C'est la bibliothèque Paho recommandée pour les nouveaux projets ; `autopaho` gère reconnexion et re-souscription seul. L'ancienne `paho.mqtt.golang` est en maintenance. |
| **`net/http` seul, pas de routeur** | Depuis Go 1.22 le `ServeMux` standard gère `GET /api/links/{a}/{b}`. Zéro dépendance de routage à suivre. |
| **TimescaleDB** | Hypertables, rétention et compression natives. L'agrégat continu horaire sert l'historique par lien. |
| **Table de liens en mémoire** | La carte est servie depuis la RAM, pas depuis SQL. Une requête bbox sur une hypertable toutes les 2 s est la seule chose qui coûterait vraiment cher. Postgres garde la durabilité et l'historique. |
| **SSE, pas WebSocket** | Trafic unidirectionnel, `EventSource` reconnecte seul, traverse les proxys sans handshake d'upgrade. |
| **Vue 3 + Pinia + TypeScript strict** | — |
| **PrimeVue 4** | `DataTable` avec scroll virtuel pour les trames, dense, Vue 3 natif, une seule dépendance UI. |
| **MapLibre GL, sans wrapper** | WebGL : des milliers d'arêtes sans toucher au DOM, `line-color` piloté par la donnée, et un rafraîchissement = un `setData`. Les wrappers Vue ajoutent une couche à maintenir pour rien ; un composable de 300 lignes suffit. |

### Rafraîchissement

Le cahier des charges disait « toutes les 10 s ». L'implémentation fait mieux et
coûte moins : le backend coalesce les changements et pousse un `links:changed`
par intervalle (2 s par défaut, `pushInterval`), le client débounce et ne refait
une requête que si quelque chose a bougé. Un maillage calme ne génère aucun
trafic ; une rafale coûte une requête. Le polling de 15 s ne sert que de secours
si le flux SSE tombe.

Les trames du lien sélectionné arrivent en push unitaire (`event: frame`), filtré
côté serveur sur le lien suivi : une carte ouverte ne paie pas le débit d'un
maillage chargé.

### Échelle de couleurs

Le réflexe rouge/orange/vert a été mesuré puis écarté : vert `#0ca30c` contre
rouge `#d03b3b` donnent un ΔE de **4.1** en deutéranopie simulée. Sur une carte,
où l'on ne peut pas étiqueter chaque ligne, cela rend le code couleur illisible
pour environ 8 % des hommes.

Le SNR est une grandeur : il prend donc une **rampe ordinale à une seule teinte**,
où c'est la luminosité qui porte l'ordre — une information que toutes les
déficiences de vision des couleurs préservent. Quatre paliers, légende donnant la
plage en dB (la couleur est un ordre, pas une valeur lisible), et un liseré
couleur de fond sous chaque ligne pour rester lisible par-dessus les tuiles.

Les deux rampes passent les contrôles ordinaux (luminosité monotone, ΔL adjacent
≥ 0.06, extrémité claire ≥ 2:1 sur son propre fond, teinte unique). Les seuils en
dB (`-12 / -5 / 5`) sont servis par `/api/config` : à ajuster selon le spreading
factor réellement utilisé.

## Démarrage

```bash
cp .env.example .env        # renseigner POSTGRES_PASSWORD
make up                     # Timescale + relayd + frontend derrière Caddy
open http://localhost:8081
```

En développement, sans base ni broker :

```bash
cd backend  && make -C .. dev          # écoute sur :8080, tout en mémoire
cd frontend && npm install && npm run dev
```

### Sans broker : rejouer une capture

```bash
mosquitto_sub -h mqtt.comchan.net -p 8883 --capath /etc/ssl/certs \
  -u mc_uplink -P mc_uplink -t 'meshcore/+/+/packets' \
  -F '{"topic":"%t","payload":%p}' > capture.ndjson

MESHQUAL_REPLAY_FILE=capture.ndjson go run ./cmd/relayd
```

## Sources

Les deux implémentations partagent la plomberie MQTT et ne diffèrent que par la
configuration ; l'interface `source.Source` existe pour qu'une troisième (port
série, rejeu, autre protocole) s'ajoute sans toucher au pipeline.

```json
{
  "sources": [
    { "id": "comchan", "brokerUrl": "mqtts://mqtt.comchan.net:8883", "topics": ["meshcore/+/+/packets"] },
    { "id": "local",   "brokerUrl": "mqtt://mosquitto:1883",        "topics": ["meshcore/+/+/packets"] }
  ]
}
```

Les identifiants se passent par l'environnement, jamais dans le fichier :
`MESHQUAL_MQTT_<ID_EN_MAJUSCULES>_USERNAME` / `_PASSWORD` / `_URL`.

Le format de charge utile toléré couvre les variantes rencontrées
(`SNR` / `snr`, valeurs en chaîne ou numériques, `raw` / `raw_hex` / `packet`) :
plusieurs ponts publient les nombres sous forme de chaînes, et un champ
strictement typé ferait disparaître silencieusement la moitié de la flotte.

## API

| Route | Réponse |
|---|---|
| `GET /api/links?bbox=&kind=&minSamples=&limit=` | `FeatureCollection` de `LineString`, consommée telle quelle par MapLibre |
| `GET /api/nodes?bbox=` | `FeatureCollection` de `Point` |
| `GET /api/links/{a}/{b}` | état agrégé du lien |
| `GET /api/links/{a}/{b}/frames?limit=10` | N dernières trames, servies depuis la RAM |
| `GET /api/links/{a}/{b}/history?window=24h&bucket=1h` | série temporelle SNR (Timescale) |
| `GET /api/stream?link=A:B` | SSE : `links:changed`, `frame` |
| `GET /api/config` | seuils SNR, cadence, bornes |
| `GET /api/health` | sources, pipeline, qualité d'attribution |

L'ordre des clés dans une URL de lien n'a pas d'importance : l'identifiant est
canonique (`a < b`), et `forward` porte le sens réel du trafic.

## Tests

```bash
make test     # Go avec -race, puis typecheck + vitest
make lint
```

Le décodeur est testé contre le format du firmware : champs de bits d'en-tête,
codes de transport, tailles de hash, chemins tronqués ou surdimensionnés,
aller-retour du SNR de trace (`int8(snr*4)`, quantum de 0,25 dB), et adverts dont
la longitude négative doit survivre. Les tests d'ingestion verrouillent la règle
centrale : un paquet à trois sauts produit **un** échantillon `measured` et deux
`topology` sans SNR.

Le test d'API fige le contrat GeoJSON, y compris l'ordre `[lng, lat]`, et
interdit les slices `null` en JSON — une slice Go nil se sérialise en `null`, ce
qui faisait planter le panneau de détail.

Vérification visuelle de bout en bout :

```bash
node e2e/screenshot.mjs out.png dark http://127.0.0.1:5173
```

## Limites connues

- **Un lien n'est traçable que si ses deux extrémités ont annoncé une position.**
  Les positions ne viennent que des paquets `ADVERT`. Le compteur « sans
  position » de la barre de statut dit combien de liens sont écartés pour ça.
- **La signature des adverts n'est pas vérifiée.** Elle est décodée et conservée ;
  la vérification Ed25519 sur la zone signée exacte reste à faire, et devrait
  marquer les nœuds plutôt que les écarter.
- **Les paquets TRACE sont rares** en observation passive : ils ne circulent que
  si quelqu'un lance un trace. C'est la seule source de SNR par saut intermédiaire.
- **Les tuiles OpenStreetMap** ont une politique d'usage qui interdit un usage
  automatisé intensif. Pointer `VITE_TILE_URL` vers son propre cache avant de
  diffuser la carte.
- `go.mod` contient un bloc `replace` marqué « sandbox-only » : il contourne un
  réseau de build sans accès à `golang.org`, et se supprime tel quel.

[disp]: https://github.com/meshcore-dev/MeshCore/blob/main/src/Dispatcher.cpp
[pkt]: https://github.com/meshcore-dev/MeshCore/blob/main/src/Packet.h
[mesh]: https://github.com/meshcore-dev/MeshCore/blob/main/src/Mesh.cpp
