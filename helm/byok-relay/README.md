# byok-relay Helm chart

Deploy byok-relay to Kubernetes with encrypted key storage, CORS configuration, a persistent SQLite volume, health probes, and optional ingress.

## Install

Create secrets first, then install the chart:

```bash
kubectl create secret generic byok-relay-secrets \
  --from-literal=ENCRYPTION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=TOKEN_HMAC_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ENCRYPTION_SALT="$(openssl rand -hex 32)" \
  --from-literal=APP_SECRET="$(openssl rand -hex 32)"

helm install byok-relay ./helm/byok-relay \
  --set secrets.create=false \
  --set secrets.existingSecret=byok-relay-secrets \
  --set config.allowedOrigins=https://your-app.example.com
```

Or let Helm create the Secret:

```bash
helm install byok-relay ./helm/byok-relay \
  --set secrets.encryptionSecret="$(openssl rand -hex 32)" \
  --set secrets.tokenHmacSecret="$(openssl rand -hex 32)" \
  --set secrets.encryptionSalt="$(openssl rand -hex 32)" \
  --set secrets.appSecret="$(openssl rand -hex 32)" \
  --set config.allowedOrigins=https://your-app.example.com
```

## Image

The chart defaults to `ghcr.io/avikalpg/byok-relay:<chart appVersion>`. If you publish or build your own image, override it:

```bash
helm upgrade --install byok-relay ./helm/byok-relay \
  --set image.repository=registry.example.com/byok-relay \
  --set image.tag=v1.1.0
```

## Persistence

SQLite data persists in a PVC mounted at `/data`, and `DB_PATH` defaults to `/data/relay.db`.

```yaml
persistence:
  enabled: true
  size: 5Gi
  storageClass: gp3
```

For an existing PVC:

```yaml
persistence:
  enabled: true
  existingClaim: byok-relay-data
```

## Ingress

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: relay.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: relay-example-com-tls
      hosts:
        - relay.example.com
```

## Production checklist

- Set `config.allowedOrigins` to your frontend domain. Avoid `*` in production.
- Set `APP_SECRET` so `POST /users` requires `Authorization: Bearer <APP_SECRET>`.
- Keep `persistence.enabled=true` unless this is a disposable demo.
- Use `secrets.existingSecret` if your cluster already manages secrets through External Secrets, SOPS, Sealed Secrets, or a cloud secret manager.
- Run one replica with SQLite. Use a future Postgres backend before scaling beyond one writable replica.

## Smoke test

```bash
helm template byok-relay ./helm/byok-relay \
  --set secrets.encryptionSecret=test-secret-at-least-32-characters-long

helm test byok-relay
```
