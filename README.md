# NEXO — Asistente personal (Etapa 0)

**Estado:** diseño ejecutable, **no desplegado**. No hay proyecto Supabase, bot ni cron corriendo.
**Fecha:** 17 de noviembre de 2026.

## Qué resuelve

Un asistente privado por Telegram para registrar y consultar compromisos, tareas, seguimientos y
recordatorios, con categorías personales/familiares/de Edubótika, **sin depender de que Harness esté
abierto**. Los pedidos que necesitan agentes quedan en una cola para la PC.

## Arquitectura

```
Telegram ──webhook──▶ Edge Function "telegram-webhook"
                          │  allowlist + idempotencia + parseo
                          ▼
                     Supabase Postgres
                     agenda_items · reminders · messages · pending_jobs · events
                          ▲
pg_cron (cada minuto) ──▶ Edge Function "tick" ──▶ Telegram (recordatorios)
pg_cron (10:30 UTC)  ──▶ Edge Function "tick" (mode=summary) ──▶ Telegram (resumen 07:30 ART)
```

No usa n8n. No hay servidor que administrar. El plan free de Supabase alcanza; el cron cada minuto
mantiene el proyecto activo (evita la pausa por inactividad).

## Archivos

| Archivo | Qué es |
|---|---|
| `schema.sql` | Tablas, índices, RLS, funciones RPC y los `cron.schedule` comentados |
| `functions/telegram-webhook.ts` | Webhook de Telegram: autorización, idempotencia, intents, respuestas |
| `functions/tick.ts` | Recordatorios vencidos + resumen diario |
| `README.md` | Este documento |

## Modelo de datos (resumen)

- `agenda_items`: `codigo` (número corto para comandos), tipo, categoría, título, estado, prioridad,
  fechas, `rrule`, `visibilidad` (personal/oficina), vínculo opcional con el ledger.
- `reminders`: cuándo avisar, anticipación (15 min por defecto), estado, intentos, clave idempotente.
- `messages`: `update_id` único, para no procesar dos veces el mismo mensaje.
- `pending_jobs`: cola para trabajos que requieren la PC/NEXO.
- `events`: auditoría.

**Privacidad:** todo vive en Supabase; nada personal se escribe en `estado/` ni lo ven PIXEL/SCOUT.

## Despliegue (cuando decidas)

### 1. Proyecto

Crear el proyecto en Supabase, región **sa-east-1** (San Pablo). Anotar el `PROJECT_REF`.

### 2. Extensiones y esquema

En **Database → Extensions**, habilitar `pg_cron`, `pg_net` y `pgcrypto` (o dejar que `schema.sql` lo
intente). Después, en el **SQL Editor**, ejecutar `schema.sql` completo.

### 3. Secretos de Vault (para el cron)

```sql
select vault.create_secret('https://<PROJECT_REF>.supabase.co/functions/v1/tick', 'nexo_tick_url');
select vault.create_secret('<secreto-aleatorio>', 'nexo_cron_secret');
```

### 4. Secretos de las funciones

```bash
supabase secrets set \
  TELEGRAM_BOT_TOKEN=<token> \
  TELEGRAM_WEBHOOK_SECRET=<aleatorio> \
  ALLOWED_USER_ID=<tu-id-numerico> \
  CRON_SECRET=<el-mismo-que-nexo_cron_secret>
```

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase.

### 5. Funciones

```bash
supabase functions deploy telegram-webhook --no-verify-jwt
supabase functions deploy tick --no-verify-jwt
```

Si el CLI no funciona (en esta PC está roto), se pueden pegar en **Edge Functions** del panel y cargar
los secretos desde la UI.

### 6. Webhook de Telegram

```python
import requests
TOKEN = "<token>"
requests.post(f"https://api.telegram.org/bot{TOKEN}/setWebhook", json={
    "url": "https://<PROJECT_REF>.supabase.co/functions/v1/telegram-webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message"],
    "drop_pending_updates": True,
}).json()
```

### 7. Cron

Descomentar y ejecutar los dos `cron.schedule` del final de `schema.sql`.

### 8. Primer mensaje

Abrir el bot, `/start`, y probar.

## Comandos

- `recordame <algo> mañana a las 9`
- `agendá <algo> el jueves a las 15`
- `recordame <algo> todos los lunes a las 9`
- `recordame <algo> de lunes a viernes a las 8`
- `recordame <algo> cada mes`
- `hoy`, `mañana`, `semana`, `pendientes`, `tareas`, `vencidas`
- `hecho 12`, `posponer 12 15`, `cancelar 12`

`hoy` muestra los compromisos que empiezan hoy **y** las tareas que vencen hoy. `mañana` y `semana`
hacen lo mismo para sus rangos; `pendientes` lista todo lo abierto sin importar la fecha.

### Categorías

Se pone la etiqueta en cualquier lugar del mensaje; sin etiqueta va a `personal`.

| Etiqueta | Categoría |
|---|---|
| `#personal` | Personal |
| `#familiar` | Familiar |
| `#admin` o `#edubotika` | Edubótika – Administración |
| `#academico` | Edubótika – Académico |
| `#comercial` | Edubótika – Comercial |
| `#marketing` | Edubótika – Marketing |
| `#proyectos` | Edubótika – Proyectos |

Las categorías personales/familiares quedan con `visibilidad = personal`; las de Edubótika, con
`visibilidad = oficina`.

### Recurrencias

- `todos los lunes`, `todos los martes y jueves`, `de lunes a viernes` → `FREQ=WEEKLY;BYDAY=…`
- `todos los días` / `cada día` → `FREQ=DAILY`
- `cada semana` → `FREQ=WEEKLY` (mismo día)
- `cada mes` → `FREQ=MONTHLY`

El tick, al enviar una ocurrencia, actualiza la fecha del ítem y crea el recordatorio de la próxima.

## Pruebas de aceptación

| # | Prueba | Esperado |
|---|---|---|
| 1 | Escribir desde otra cuenta de Telegram | Ignorado + evento `telegram_no_autorizado` |
| 2 | Reenviar el mismo update | No se procesa dos veces (`messages.update_id`) |
| 3 | `recordame pagar la luz mañana a las 9` | Ítem + recordatorio; respuesta con `#codigo` |
| 4 | `hoy` | Lista con el ítem |
| 5 | `hecho 12` | Estado `hecho`, recordatorio cancelado |
| 6 | `posponer 12 15` | Recordatorio +15 min |
| 7 | Llegar la hora | Llega el aviso a Telegram **con la PC apagada** |
| 8 | Reiniciar/forzar el tick | Sin duplicados (idempotencia + `enviando`) |
| 9 | 07:30 ART | Resumen con hoy, pendientes, vencidas, seguimientos |
| 10 | `anon` key contra la tabla | Sin acceso (RLS) |
| 11 | Fallo de Telegram | `intentos` sube; a los 5 queda `error` |
| 12 | Borrar el secreto del webhook | La función responde 403 |

## Puente NEXO ↔ agenda

En la PC, NEXO consulta y escribe la agenda con `tools/edubotika/agenda.py`. La `service_role` se
guarda cifrada con DPAPI, fuera del workspace:

```bash
python tools/edubotika/set_cred.py
python tools/edubotika/agenda.py hoy
```

Comandos: `hoy`, `manana`, `semana`, `pendientes`, `vencidas`, `buscar "..."`, `inbox`, `add`,
`hecho`, `cancelar`, `posponer`.

## Bandeja de pedidos

`pedido <texto>` en Telegram crea un `pending_jobs`. El conector de la PC
(`connector.py --once`) lo baja a `runtime/inbox/agenda/req-<id>.json`. NEXO lo procesa y deja
`runtime/outbox/agenda/res-<id>.json`; el conector lo sube y el tick avisa por Telegram.

Instalar el conector cada 5 minutos:

```powershell
.\install_connector_task.ps1
```

## Backup

```bash
python tools/edubotika/set_cred.py   # incluir db_url en el tercer paso
python tools/edubotika/backup_agenda.py
```

Instalar la tarea diaria de las 12:00:

```powershell
.\install_backup_task.ps1
```

## GitHub

```powershell
.\sync_repo.ps1
git init
git add .gitignore README.md schema.sql functions supabase
git commit -m "NEXO asistente: esquema y funciones"
git branch -M main
git remote add origin https://github.com/edumferreyra/nexo.git
git push -u origin main
```

El repo incluye `supabase/migrations/0001_init.sql` y `0002_pending_jobs_notificado.sql`; la
integración de Supabase los aplica. No hay secretos.

## D19

```powershell
# PowerShell como administrador
..\seguridad\cerrar_puertos.ps1
```

## Despliegue de esta fase

1. SQL Editor: ejecutar `supabase/migrations/0002_pending_jobs_notificado.sql`.
2. Redeploy `telegram-webhook` y `tick`.
3. `set_cred.py` en la PC.
4. Instalar las tareas del conector y del backup.

## Seguridad

- Bot privado, sin grupos; `ALLOWED_USER_ID` numérico.
- Webhook con `secret_token` de Telegram.
- `tick` con `x-cron-secret`.
- RLS activo; sin políticas para `anon`/`authenticated`.
- `service_role` solo en las Edge Functions.
- Token rotable; nunca en el repo ni en el chat.
- Datos personales fuera del workspace.
- Retención: 3 años; backup con `backup_agenda.py` + tarea diaria.

## Límites de esta etapa

1. **Recurrencia simple**: DAILY, WEEKLY (con BYDAY) y MONTHLY. No hay EXDATE ni fin de serie.
2. **Sin ICS** para el calendario del teléfono.
3. **El despertar de NEXO para la bandeja es manual**: el conector baja los pedidos, pero NEXO los
   procesa cuando abrís la sesión o le pedís que revise `runtime/inbox/agenda/`.
4. **Parseo determinístico**: no usa LLM; frases fuera de los patrones piden reformular.
5. **Un solo usuario**.
6. **Plan free**: si el proyecto se pausa, el cron se detiene; se reactiva desde el panel.
7. **Backup**: requiere `pg_dump` y la `db_url` cargada.

## Actualización de esta fase

1. Ejecutar `0002_pending_jobs_notificado.sql`.
2. Redeploy `telegram-webhook` y `tick`.
3. `set_cred.py`, tareas del conector y backup.
4. D19 y GitHub.

## Próximos pasos

1. Probar un pedido de punta a punta: Telegram → conector → NEXO → respuesta.
2. Despertar automático de NEXO (tarea de Harness con sesión dedicada).
3. Fase 4: ICS y seguimientos.

