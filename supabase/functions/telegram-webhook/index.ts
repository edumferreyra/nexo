// NEXO — webhook de Telegram (Supabase Edge Function, Deno)
// Fase 1: categorías (#familiar, #comercial, ...) y recurrencias.
//
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ALLOWED_USER_ID,
//          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const ALLOWED_USER = Number(Deno.env.get("ALLOWED_USER_ID"));

const TZ_MIN = -180; // ART (UTC-3)
const pad2 = (n: number) => String(n).padStart(2, "0");

const CATEGORIAS: Record<string, string> = {
  personal: "personal",
  familiar: "familiar",
  edubotika: "edubotika_admin",
  admin: "edubotika_admin",
  academico: "academico",
  comercial: "comercial",
  marketing: "marketing",
  proyectos: "proyectos",
};

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
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};
const COD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function artNow(): Date {
  return new Date(Date.now() + TZ_MIN * 60_000);
}

function isoArt(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:00-03:00`;
}

function rangoDia(offset: number): { inicio: string; fin: string } {
  const art = artNow();
  const base = new Date(Date.UTC(art.getUTCFullYear(), art.getUTCMonth(), art.getUTCDate() + offset));
  const sig = new Date(Date.UTC(art.getUTCFullYear(), art.getUTCMonth(), art.getUTCDate() + offset + 1));
  const f = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return { inicio: `${f(base)}T00:00:00-03:00`, fin: `${f(sig)}T00:00:00-03:00` };
}

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function parseFecha(texto: string): { iso: string; todoElDia: boolean } | null {
  const t = normalizar(texto);
  const base = artNow();
  const fecha = new Date(base);
  let tieneFecha = false;
  let todoElDia = false;

  if (/\bpasado\s+ma[nñ]ana\b/.test(t)) {
    fecha.setUTCDate(fecha.getUTCDate() + 2);
    tieneFecha = true;
  } else if (/\bma[nñ]ana\b/.test(t)) {
    fecha.setUTCDate(fecha.getUTCDate() + 1);
    tieneFecha = true;
  } else if (/\bhoy\b/.test(t)) {
    tieneFecha = true;
  } else {
    const dias = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
    for (let i = 0; i < dias.length; i++) {
      if (new RegExp(`\\b${dias[i]}\\b`).test(t)) {
        const actual = fecha.getUTCDay();
        let delta = (i - actual + 7) % 7;
        if (delta === 0) delta = 7;
        fecha.setUTCDate(fecha.getUTCDate() + delta);
        tieneFecha = true;
        break;
      }
    }
  }

  if (!tieneFecha) {
    const m = t.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
    if (m) {
      fecha.setUTCMonth(Number(m[2]) - 1, Number(m[1]));
      if (fecha < base) fecha.setUTCFullYear(fecha.getUTCFullYear() + 1);
      tieneFecha = true;
      todoElDia = true;
    }
  }

  const h = t.match(/\b(?:a\s+las?|al?)\s*(\d{1,2})(?::(\d{2}))?\s*(?:hs?|horas?)?\b/);
  if (h) {
    fecha.setUTCHours(Number(h[1]), Number(h[2] ?? 0), 0, 0);
    todoElDia = false;
  } else if (tieneFecha) {
    fecha.setUTCHours(9, 0, 0, 0);
    todoElDia = true;
  }

  if (!tieneFecha) return null;
  return { iso: isoArt(fecha), todoElDia };
}

function extraerCategoria(texto: string): { categoria: string; limpio: string } {
  const m = texto.match(/#(personal|familiar|edubotika|admin|academico|comercial|marketing|proyectos)\b/i);
  if (!m) return { categoria: "personal", limpio: texto };
  const categoria = CATEGORIAS[m[1].toLowerCase()] ?? "personal";
  return { categoria, limpio: texto.replace(m[0], " ") };
}

function detectarRecurrencia(texto: string): { rrule: string | null; limpio: string } {
  const t = normalizar(texto);
  let limpio = texto;
  const quitar = (re: RegExp) => { limpio = limpio.replace(re, " "); };

  if (/\b(todos los dias|diariamente|cada dia)\b/.test(t)) {
    quitar(/\b(todos los dias|diariamente|cada dia)\b/gi);
    return { rrule: "FREQ=DAILY", limpio };
  }

  const rango = t.match(/\bde (domingo|lunes|martes|miercoles|jueves|viernes|sabado) a (domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/);
  if (rango) {
    const desde = DIAS[rango[1]], hasta = DIAS[rango[2]];
    const dias: number[] = [];
    for (let i = desde; dias.length < 7; i = (i + 1) % 7) {
      dias.push(i);
      if (i === hasta) break;
    }
    quitar(/\bde\s+[a-záéíóúñ]+\s+a\s+[a-záéíóúñ]+\b/gi);
    return { rrule: "FREQ=WEEKLY;BYDAY=" + dias.map((i) => COD[i]).join(","), limpio };
  }

  if (/\btodos los\b/.test(t)) {
    const encontrados = Object.keys(DIAS).filter((d) => new RegExp(`\\b${d}\\b`).test(t));
    if (encontrados.length) {
      quitar(/\btodos los\b/gi);
      for (const d of encontrados) quitar(new RegExp(`\\b${d}\\b`, "gi"));
      return { rrule: "FREQ=WEEKLY;BYDAY=" + encontrados.map((d) => COD[DIAS[d]]).join(","), limpio };
    }
  }

  if (/\bcada semana\b/.test(t)) {
    quitar(/\bcada semana\b/gi);
    return { rrule: "FREQ=WEEKLY", limpio };
  }
  if (/\bcada mes\b/.test(t)) {
    quitar(/\bcada mes\b/gi);
    return { rrule: "FREQ=MONTHLY", limpio };
  }
  return { rrule: null, limpio };
}

async function enviar(chatId: number, texto: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto.slice(0, 4000), disable_web_page_preview: true }),
  });
}

function fmt(d: string | null): string {
  if (!d) return "sin fecha";
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Cordoba",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(d));
}

const AYUDA = [
  "NEXO — agenda y recordatorios",
  "",
  "• recordame <algo> mañana a las 9",
  "• agendá <algo> el jueves a las 15",
  "• recordame <algo> todos los lunes a las 9",
  "• hoy / mañana / semana / pendientes",
  "• tareas / vencidas",
  "• pedido <algo que resuelve NEXO>",
  "• hecho <número> · posponer <número> 15 · cancelar <número>",
  "",
  "Categorías: #personal, #familiar, #admin, #academico,",
  "#comercial, #marketing, #proyectos",
].join("\n");

async function crear(chatId: number, texto: string, tipo: string): Promise<string> {
  const { categoria, limpio: sinCat } = extraerCategoria(texto);
  const { rrule, limpio: sinRec } = detectarRecurrencia(sinCat);
  const cuando = parseFecha(texto);
  if (!cuando) {
    return "Necesito una fecha: «mañana», «el jueves», «12/12», «a las 9».\n\n" + AYUDA;
  }

  const limpio = sinRec
    .replace(/^\s*(recordame|recu[eé]rdame|recordar|agend[aá]|agenda|evento)\s*/i, "")
    .replace(/\b(pasado\s+ma[nñ]ana|ma[nñ]ana|hoy)\b/gi, " ")
    .replace(/\bel\s+(domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)\b/gi, " ")
    .replace(/\ba\s+las?\s*\d{1,2}(:\d{2})?\s*(hs?|horas?)?\b/gi, " ")
    .replace(/\b\d{1,2}[\/\-]\d{1,2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const titulo = (limpio || (tipo === "compromiso" ? "Compromiso" : "Recordatorio")).slice(0, 200);
  const visibilidad = categoria === "personal" || categoria === "familiar" ? "personal" : "oficina";

  const { data: item, error } = await sb.from("agenda_items").insert({
    tipo,
    categoria,
    titulo,
    empieza: cuando.todoElDia ? null : cuando.iso,
    vence: cuando.todoElDia ? cuando.iso : null,
    todo_el_dia: cuando.todoElDia,
    rrule,
    origen: "telegram",
    visibilidad,
  }).select("id, codigo, titulo").single();

  if (error || !item) return "No pude guardarlo: " + (error?.message ?? "error");

  const anticipacion = tipo === "compromiso" ? 15 : 0;
  const dispara = new Date(new Date(cuando.iso).getTime() - anticipacion * 60_000).toISOString();

  await sb.from("reminders").insert({
    item_id: item.id,
    dispara_en: dispara,
    anticipacion_min: anticipacion,
    clave_idempotencia: `${item.id}:${cuando.iso}`,
  });

  return `✅ #${item.codigo} [${ETIQUETA[categoria] ?? categoria}] ${item.titulo}\n` +
    `📅 ${fmt(cuando.iso)}` +
    (rrule ? `\n🔁 ${rrule}` : "") +
    (anticipacion ? `\n⏰ aviso ${anticipacion} min antes` : "");
}

async function itemsEnRango(inicio: string, fin: string) {
  const sel = "codigo,titulo,empieza,vence,tipo,estado,categoria";
  const base = () => sb.from("agenda_items").select(sel).not("estado", "in", "(hecho,cancelado)");
  const [porInicio, porVence] = await Promise.all([
    base().gte("empieza", inicio).lt("empieza", fin),
    base().gte("vence", inicio).lt("vence", fin),
  ]);
  const mapa = new Map<number, any>();
  for (const x of [...(porInicio.data ?? []), ...(porVence.data ?? [])]) mapa.set(Number(x.codigo), x);
  return [...mapa.values()].sort((x, y) =>
    String(x.empieza ?? x.vence ?? "").localeCompare(String(y.empieza ?? y.vence ?? ""))
  );
}

async function listar(chatId: number, modo: string) {
  let filas: any[] = [];

  if (modo === "hoy" || modo === "manana" || modo === "semana") {
    const desde = rangoDia(0).inicio;
    const hasta = modo === "semana" ? rangoDia(7).inicio : rangoDia(modo === "manana" ? 1 : 0).fin;
    filas = await itemsEnRango(desde, hasta);
  } else if (modo === "tareas") {
    const { data } = await sb.from("agenda_items")
      .select("codigo,titulo,empieza,vence,tipo,estado,categoria")
      .eq("tipo", "tarea").eq("estado", "pendiente")
      .order("vence", { nullsFirst: false }).limit(20);
    filas = data ?? [];
  } else if (modo === "vencidas") {
    const { data } = await sb.from("agenda_items")
      .select("codigo,titulo,empieza,vence,tipo,estado,categoria")
      .lt("vence", new Date().toISOString()).not("estado", "in", "(hecho,cancelado)")
      .order("vence", { nullsFirst: false }).limit(20);
    filas = data ?? [];
  } else {
    const { data } = await sb.from("agenda_items")
      .select("codigo,titulo,empieza,vence,tipo,estado,categoria")
      .in("estado", ["pendiente", "en_curso"])
      .in("tipo", ["tarea", "compromiso", "seguimiento"])
      .limit(30);
    filas = (data ?? []).sort((x, y) =>
      String(x.vence ?? x.empieza ?? "").localeCompare(String(y.vence ?? y.empieza ?? ""))
    );
  }

  if (!filas.length) {
    const vacio: Record<string, string> = {
      hoy: "Nada para hoy. Probá «mañana», «semana» o «tareas».",
      manana: "Nada para mañana.",
      semana: "Sin pendientes en los próximos 7 días.",
      tareas: "Sin tareas pendientes.",
      vencidas: "Sin vencidas.",
      pendientes: "Sin pendientes.",
    };
    return vacio[modo] ?? "Sin resultados.";
  }

  return filas.slice(0, 20).map((x) =>
    `#${x.codigo} [${ETIQUETA[x.categoria] ?? x.categoria}] ${fmt(x.empieza ?? x.vence)} · ${x.titulo}`
  ).join("\n");
}

async function accion(chatId: number, texto: string, verbo: string) {
  const m = texto.match(/(\d+)/);
  if (!m) return `Decime el número: «${verbo} 12».`;
  const codigo = Number(m[1]);
  const { data: item } = await sb.from("agenda_items").select("*").eq("codigo", codigo).maybeSingle();
  if (!item) return `No encontré #${codigo}.`;

  if (verbo === "hecho") {
    await sb.from("agenda_items").update({ estado: "hecho", completado_en: new Date().toISOString() }).eq("id", item.id);
    await sb.rpc("cancel_reminders_for_item", { p_item: item.id });
    return `✅ #${codigo} ${item.titulo}`;
  }
  if (verbo === "cancelar") {
    await sb.from("agenda_items").update({ estado: "cancelado", cancelado_en: new Date().toISOString() }).eq("id", item.id);
    await sb.rpc("cancel_reminders_for_item", { p_item: item.id });
    return `🗑️ #${codigo} cancelado.`;
  }

  const min = texto.includes("30") ? 30 : 15;
  const { data: rem } = await sb.from("reminders")
    .select("id,dispara_en").eq("item_id", item.id).eq("estado", "pendiente")
    .order("dispara_en").limit(1).maybeSingle();
  if (rem) {
    const nuevo = new Date(new Date(rem.dispara_en).getTime() + min * 60_000).toISOString();
    await sb.from("reminders").update({ dispara_en: nuevo }).eq("id", rem.id);
    return `⏰ #${codigo} pospuesto ${min} min.`;
  }
  const nuevo = new Date(Date.now() + min * 60_000).toISOString();
  await sb.from("reminders").insert({
    item_id: item.id, dispara_en: nuevo, anticipacion_min: 0,
    clave_idempotencia: `${item.id}:snooze:${nuevo}`,
  });
  return `⏰ #${codigo} aviso en ${min} min.`;
}

async function manejar(texto: string, chatId: number, updateId: number): Promise<string> {
  const t = texto.trim();
  // La etiqueta de categoría puede ir en cualquier lado: se ignora para el comando.
  const low = normalizar(t).replace(/#[a-z]+/g, " ").replace(/\s+/g, " ").trim();

  if (low === "/start" || low === "/ayuda" || low === "ayuda") return AYUDA;

  if (/^(pedido|nexo:)/.test(low)) {
    const pedido = t.replace(/^(pedido|nexo:)\s*/i, "").trim();
    if (!pedido) return "Decime qué pedido.";
    const { data, error } = await sb.from("pending_jobs").insert({
      payload: { texto: pedido, chat_id: chatId, update_id: updateId, origen: "telegram" },
    }).select("id").single();
    if (error || !data) return "No pude encolarlo: " + (error?.message ?? "");
    return `📥 En cola (${String(data.id).slice(0, 8)}). Te aviso cuando NEXO lo procese.`;
  }
  if (low === "/hoy" || low === "hoy") return await listar(chatId, "hoy");
  if (low === "/manana" || low === "manana" || low === "/mañana" || low === "mañana") return await listar(chatId, "manana");
  if (low === "/semana" || low === "semana") return await listar(chatId, "semana");
  if (low === "/pendientes" || low === "pendientes") return await listar(chatId, "pendientes");
  if (low === "/tareas" || low === "tareas") return await listar(chatId, "tareas");
  if (low === "/vencidas" || low === "vencidas") return await listar(chatId, "vencidas");

  if (/^(hecho|listo|terminado)\b/.test(low)) return await accion(chatId, low, "hecho");
  if (/^(cancelar|cancela|borrar)\b/.test(low)) return await accion(chatId, low, "cancelar");
  if (/^(posponer|postergar|despues)\b/.test(low)) return await accion(chatId, low, "posponer");

  if (/^(recordame|recuerdame|recordar)\b/.test(low)) return await crear(chatId, t, "recordatorio");
  if (/^(agenda|agendá|evento|turno|reunion|reunión|clase)\b/.test(low)) return await crear(chatId, t, "compromiso");

  if (parseFecha(t)) return await crear(chatId, t, "tarea");
  return "No entendí. " + AYUDA;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let update: any;
  try { update = await req.json(); } catch { return new Response("bad request", { status: 400 }); }

  const msg = update?.message;
  if (!msg?.text || !msg?.from || !msg?.chat) return new Response("ok");

  const userId = Number(msg.from.id);
  const chatId = Number(msg.chat.id);
  if (userId !== ALLOWED_USER) {
    await sb.from("events").insert({ accion: "telegram_no_autorizado", payload: { user_id: userId }, canal: "telegram" });
    return new Response("ok");
  }

  const { error: dup } = await sb.from("messages").insert({
    update_id: update.update_id, chat_id: chatId, user_id: userId, texto: msg.text,
  });
  if (dup?.code === "23505") return new Response("ok");

  try {
    await enviar(chatId, await manejar(msg.text, chatId, Number(update.update_id)));
  } catch (e) {
    await enviar(chatId, "Error interno: " + String(e).slice(0, 200));
  }
  return new Response("ok");
});
