// NEXO — tick de recordatorios y resumen (Supabase Edge Function, Deno)
// Fase 1: al enviar un recordatorio recurrente, programa la próxima ocurrencia.
//
// Secrets: TELEGRAM_BOT_TOKEN, CRON_SECRET, ALLOWED_USER_ID,
//          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const CHAT_ID = Number(Deno.env.get("ALLOWED_USER_ID"));

const TZ_MIN = -180;
const p = (n: number) => String(n).padStart(2, "0");

const ETIQUETA: Record<string, string> = {
  personal: "Personal",
  familiar: "Familiar",
  edubotika_admin: "Edubótika",
  academico: "Académico",
  comercial: "Comercial",
  marketing: "Marketing",
  proyectos: "Proyectos",
};

const DIAS: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

function fmt(d: string | null): string {
  if (!d) return "sin fecha";
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Cordoba",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(d));
}

async function enviar(texto: string) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: texto.slice(0, 4000), disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

function rangoHoy(): { inicio: string; fin: string } {
  const art = new Date(Date.now() + TZ_MIN * 60_000);
  const y = art.getUTCFullYear(), m = art.getUTCMonth(), d = art.getUTCDate();
  const inicio = `${y}-${p(m + 1)}-${p(d)}T00:00:00-03:00`;
  const sig = new Date(Date.UTC(y, m, d + 1));
  const fin = `${sig.getUTCFullYear()}-${p(sig.getUTCMonth() + 1)}-${p(sig.getUTCDate())}T00:00:00-03:00`;
  return { inicio, fin };
}

// Próxima ocurrencia de un RRULE simple: FREQ=DAILY | WEEKLY[;BYDAY=..] | MONTHLY
function siguiente(rrule: string, desdeISO: string): string {
  const d = new Date(desdeISO);
  const freq = /FREQ=([A-Z]+)/.exec(rrule)?.[1];
  const byday = /BYDAY=([A-Z,]+)/.exec(rrule)?.[1]?.split(",").filter(Boolean);

  if (freq === "DAILY") {
    d.setUTCDate(d.getUTCDate() + 1);
  } else if (freq === "WEEKLY" && byday?.length) {
    for (let i = 1; i <= 14; i++) {
      const c = new Date(d);
      c.setUTCDate(c.getUTCDate() + i);
      if (byday.some((x) => DIAS[x] === c.getUTCDay())) {
        d.setTime(c.getTime());
        break;
      }
    }
  } else if (freq === "WEEKLY") {
    d.setUTCDate(d.getUTCDate() + 7);
  } else if (freq === "MONTHLY") {
    d.setUTCMonth(d.getUTCMonth() + 1);
  } else {
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return d.toISOString();
}

async function resumen(): Promise<string> {
  const { inicio, fin } = rangoHoy();
  const ahora = new Date().toISOString();
  const en7 = new Date(Date.now() + 7 * 86_400_000).toISOString();

  const [comps, tareas, vencidas, seguimientos] = await Promise.all([
    sb.from("agenda_items").select("codigo,titulo,empieza,categoria")
      .gte("empieza", inicio).lt("empieza", fin)
      .not("estado", "in", "(hecho,cancelado)").order("empieza"),
    sb.from("agenda_items").select("codigo,titulo,vence,categoria")
      .eq("tipo", "tarea").eq("estado", "pendiente").order("vence", { nullsFirst: false }).limit(10),
    sb.from("agenda_items").select("codigo,titulo,vence,categoria")
      .lt("vence", ahora).not("estado", "in", "(hecho,cancelado)").limit(10),
    sb.from("agenda_items").select("codigo,titulo,vence,categoria")
      .eq("tipo", "seguimiento").not("estado", "in", "(hecho,cancelado)")
      .lte("vence", en7).limit(10),
  ]);

  const seccion = (titulo: string, filas: any[] | null, campo: string) => {
    if (!filas?.length) return "";
    return `\n${titulo}\n` + filas.map((x) =>
      `#${x.codigo} [${ETIQUETA[x.categoria] ?? x.categoria}] ${fmt(x[campo])} · ${x.titulo}`
    ).join("\n") + "\n";
  };

  const texto = `☀️ Buenos días\n` +
    seccion("Hoy", comps.data, "empieza") +
    seccion("Tareas pendientes", tareas.data, "vence") +
    seccion("Vencidas", vencidas.data, "vence") +
    seccion("Seguimientos", seguimientos.data, "vence");

  return texto.trim() === "☀️ Buenos días" ? "☀️ Buenos días. Sin novedades." : texto;
}

async function recordatorios(): Promise<number> {
  const { data: due, error } = await sb.rpc("claim_due_reminders", { p_limit: 20 });
  if (error) throw new Error(error.message);
  let enviados = 0;

  for (const r of due ?? []) {
    const { data: item } = await sb.from("agenda_items")
      .select("codigo,titulo,empieza,vence,estado,categoria,rrule")
      .eq("id", r.item_id).maybeSingle();

    if (!item || item.estado === "hecho" || item.estado === "cancelado") {
      await sb.rpc("mark_reminder_sent", { p_id: r.id });
      continue;
    }

    const cuando = item.empieza ?? item.vence;
    try {
      await enviar(
        `⏰ #${item.codigo} [${ETIQUETA[item.categoria] ?? item.categoria}] ${item.titulo}\n` +
        `📅 ${fmt(cuando)}\n\n` +
        `hecho ${item.codigo} · posponer ${item.codigo} 15 · cancelar ${item.codigo}`,
      );
      await sb.rpc("mark_reminder_sent", { p_id: r.id });
      enviados++;

      if (item.rrule) {
        const campo = item.empieza ? "empieza" : "vence";
        let next = siguiente(item.rrule, cuando!);
        let guard = 0;
        while (new Date(next) <= new Date() && guard++ < 60) {
          next = siguiente(item.rrule, next);
        }
        await sb.from("agenda_items").update({ [campo]: next }).eq("id", r.item_id);
        await sb.from("reminders").upsert({
          item_id: r.item_id,
          dispara_en: new Date(new Date(next).getTime() - r.anticipacion_min * 60_000).toISOString(),
          anticipacion_min: r.anticipacion_min,
          clave_idempotencia: `${r.item_id}:${next}`,
        }, { onConflict: "clave_idempotencia", ignoreDuplicates: true });
      }
    } catch (e) {
      await sb.rpc("mark_reminder_failed", { p_id: r.id, p_error: String(e) });
    }
  }
  return enviados;
}

async function notificarResultados(): Promise<number> {
  const { data } = await sb.from("pending_jobs")
    .select("id,resultado")
    .eq("estado", "hecho")
    .is("notificado_en", null)
    .limit(10);

  let enviados = 0;
  for (const j of data ?? []) {
    const texto = j.resultado && typeof j.resultado === "object" && typeof j.resultado.texto === "string"
      ? j.resultado.texto
      : "Pedido listo.";
    await enviar(`📬 ${texto}`);
    await sb.from("pending_jobs").update({ notificado_en: new Date().toISOString() }).eq("id", j.id);
    enviados++;
  }
  return enviados;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let modo = "tick";
  try { modo = (await req.json())?.mode ?? "tick"; } catch { /* sin body */ }

  try {
    if (modo === "summary") {
      await enviar(await resumen());
      return Response.json({ ok: true, modo });
    }
    const enviados = await recordatorios();
    const jobs = await notificarResultados();
    return Response.json({ ok: true, enviados, jobs });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
