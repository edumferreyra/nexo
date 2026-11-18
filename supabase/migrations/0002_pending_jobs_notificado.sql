-- 0002 — notificación de resultados de la bandeja
-- Ejecutar en el SQL Editor ANTES de desplegar el tick nuevo.

alter table public.pending_jobs
  add column if not exists notificado_en timestamptz;

create index if not exists pending_jobs_notificar_idx
  on public.pending_jobs (estado, notificado_en);
