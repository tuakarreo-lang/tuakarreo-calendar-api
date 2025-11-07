/**
 * server.js
 * Tu Akarreo - API de disponibilidad y reservas (Google Calendar)
 *
 * Requerimientos:
 * - credentials.json (Service Account) en la raíz del proyecto (Render: use Secret File path)
 * - Cada calendario de conductor debe estar compartido con la cuenta de servicio
 * - Deploy recomendado en Render / Railway / similar
 */

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- Autenticación Google ----------
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, // usa la variable .env
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({ version: "v3", auth });

// ✅ Endpoint raíz de prueba
app.get("/", (req, res) => {
  res.send("✅ API Tu Akarreo Calendar funcionando correctamente 🚀");
});

// ---------- Reglas de duración (horas) ----------
function duracionPorTipoYVolumen(tipoFlete = "", metrosCubicos = 0) {
  const tipo = (tipoFlete || "").toLowerCase();
  const m = parseFloat(metrosCubicos || 0);

  if (tipo.includes("mobiliario") || (tipo.includes("mercancia") && tipo.includes("mobiliario"))) {
    return 0.33; // 20 minutos
  }

  if (tipo.includes("mudanza")) {
    if (m <= 7.5) return 2;
    if (m <= 12) return 2.5;
    if (m <= 17) return 3;
    if (m <= 26) return 4;
    if (m <= 33) return 5;
    return 6;
  }

  return 1; // valor por defecto
}

// Estimación de desplazamiento urbano promedio (km/h)
function estimarDesplazamientoHoras(distanciaKm = null) {
  if (distanciaKm && !isNaN(distanciaKm)) {
    const velocidadProm = 35;
    return distanciaKm / velocidadProm;
  }
  return 0.5; // fallback si no hay distancia
}

// Horario operativo (rango permitido)
const OPERATIVE_START_HOUR = 6;  // 06:00
const OPERATIVE_END_HOUR = 20;   // 20:00

// ---------- Helper ----------
function isoFromDateTimeLocal(fechaYYYYMMDD, horaHHMM) {
  return new Date(`${fechaYYYYMMDD}T${horaHHMM}:00-05:00`);
}

// ---------- Buscar disponibilidad ----------
/**
 * POST /api/calendar/search
 * body: { fecha: "YYYY-MM-DD", ciudadOrigen: "Pereira", metrosCubicos: number, tipoFlete: "mudanza" }
 */
app.post("/api/calendar/search", async (req, res) => {
  try {
    const { fecha, ciudadOrigen = "", metrosCubicos = 0, tipoFlete = "" } = req.body;
    if (!fecha) return res.status(400).json({ error: "Falta la fecha (YYYY-MM-DD)" });

    console.log(`🔎 Buscando disponibilidad: ${fecha}, ${ciudadOrigen}, ${tipoFlete}, ${metrosCubicos}m³`);

    // Listar hasta 250 calendarios
    const listRes = await calendar.calendarList.list({ maxResults: 250 });
    const calendars = listRes.data.items || [];

    // Filtrar candidatos por ciudad y estado
    const candidates = calendars.filter(c => {
      const s = (c.summary || "").toLowerCase();
      if (!s) return false;
      if (ciudadOrigen && !s.includes(ciudadOrigen.toLowerCase())) return false;
      if (s.includes("inactivo") || s.includes("pausado")) return false;
      return true;
    });

    console.log(`📅 Calendarios activos encontrados: ${candidates.length}`);

    // Construir slots base (cada 30 minutos)
    const slotsBase = [];
    for (let h = OPERATIVE_START_HOUR; h <= OPERATIVE_END_HOUR; h++) {
      for (let m of [0, 30]) {
        const hh = String(h).padStart(2, "0");
        const mm = String(m).padStart(2, "0");
        slotsBase.push(`${fecha}T${hh}:${mm}:00-05:00`);
      }
    }

    // Iterar sobre los calendarios y buscar disponibilidad
    for (const cal of candidates) {
      const parts = (cal.summary || "").split("/").map(p => p.trim());
      const calendarCode = parts[2] || cal.summary;
      const vehicleType = parts[3] || "";
      const maxM3Match = (parts[4] || "").match(/([0-9]+(?:\.[0-9]+)?)/);
      const maxM3 = maxM3Match ? parseFloat(maxM3Match[1]) : 9999;

      if (maxM3 < parseFloat(metrosCubicos || 0)) continue;

      const timeMin = new Date(`${fecha}T00:00:00-05:00`).toISOString();
      const timeMax = new Date(`${fecha}T23:59:59-05:00`).toISOString();

      const evRes = await calendar.events.list({
        calendarId: cal.id,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime"
      });

      const booked = (evRes.data.items || []).map(ev => ({
        start: new Date(ev.start.dateTime || ev.start.date),
        end: new Date(ev.end.dateTime || ev.end.date),
      }));

      const estimatedServiceHours = duracionPorTipoYVolumen(tipoFlete, metrosCubicos);
      const availableSlots = [];

      for (const slotISO of slotsBase) {
        const slotStart = new Date(slotISO);
        const slotEnd = new Date(slotStart.getTime() + estimatedServiceHours * 3600000);
        if (slotStart.getHours() < OPERATIVE_START_HOUR || slotEnd.getHours() > OPERATIVE_END_HOUR + 1) continue;
        const conflict = booked.some(ev => slotStart < ev.end && slotEnd > ev.start);
        if (!conflict) availableSlots.push(slotStart.toISOString());
      }

      if (availableSlots.length > 0) {
        console.log(`✅ Disponibilidad encontrada en ${calendarCode}`);
        return res.json({
          available: true,
          calendar: {
            calendarId: cal.id,
            calendarCode,
            vehicleType,
            maxM3,
            availableSlots
          }
        });
      }
    }

    console.log("❌ No hay disponibilidad en los calendarios activos");
    return res.json({ available: false });

  } catch (err) {
    console.error("💥 Error /api/calendar/search:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------- Crear reserva ----------
/**
 * POST /api/calendar/reserve
 * body: { calendarId, fecha, slotISO, origen, destino, tipoFlete, metrosCubicos, distanciaKm?, cliente: { nombre, email, telefono } }
 */
app.post("/api/calendar/reserve", async (req, res) => {
  try {
    const {
      calendarId,
      fecha,
      slotISO,
      origen = "",
      destino = "",
      tipoFlete = "",
      metrosCubicos = 0,
      distanciaKm = null,
      cliente = {}
    } = req.body;

    if (!calendarId || !slotISO || !fecha) {
      return res.status(400).json({ error: "Faltan parámetros obligatorios (calendarId, fecha o slotISO)" });
    }

    const duracionBase = duracionPorTipoYVolumen(tipoFlete, metrosCubicos);
    const duracionTraslado = estimarDesplazamientoHoras(distanciaKm);

    const dayStart = new Date(`${fecha}T00:00:00-05:00`).toISOString();
    const slotStartDate = new Date(slotISO);

    const eventsBefore = await calendar.events.list({
      calendarId,
      timeMin: dayStart,
      timeMax: slotISO,
      singleEvents: true,
      orderBy: "startTime"
    });

    const esPrimerServicio = (eventsBefore.data.items || []).length === 0;
    const bufferHoras = esPrimerServicio ? 0 : 1;
    const duracionTotalHoras = duracionBase + duracionTraslado + bufferHoras;

    const start = slotStartDate;
    const end = new Date(start.getTime() + duracionTotalHoras * 3600000);

    // Verificar conflictos
    const evRes = await calendar.events.list({
      calendarId,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime"
    });

    if ((evRes.data.items || []).length > 0) {
      return res.status(409).json({ error: "El horario ya está ocupado." });
    }

    // Crear evento
    const event = {
      summary: `Reserva Tu Akarreo - ${cliente.nombre || "Cliente"}`,
      description:
        `Cliente: ${cliente.nombre || ""}\nTel: ${cliente.telefono || ""}\nEmail: ${cliente.email || ""}\n` +
        `Tipo: ${tipoFlete}\nM3: ${metrosCubicos}\nOrigen: ${origen}\nDestino: ${destino}\nDuración(h): ${duracionTotalHoras.toFixed(2)}`,
      start: { dateTime: start.toISOString(), timeZone: "America/Bogota" },
      end: { dateTime: end.toISOString(), timeZone: "America/Bogota" },
    };

    const insertRes = await calendar.events.insert({ calendarId, requestBody: event });

    console.log(`🗓️ Reserva creada en ${calendarId}: ${insertRes.data.id}`);

    return res.json({
      success: true,
      reservation: {
        calendarId,
        start: start.toISOString(),
        end: end.toISOString(),
        eventId: insertRes.data.id,
        htmlLink: insertRes.data.htmlLink,
      }
    });

  } catch (err) {
    console.error("💥 Error /api/calendar/reserve:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------- GET por error ----------
app.get("/api/calendar/search", (req, res) => {
  res.status(405).json({
    error: "Usa POST en /api/calendar/search con JSON { fecha, ciudadOrigen, tipoFlete, metrosCubicos }"
  });
});
/* ==========================================================
   ✅ RUTA POST para búsqueda de disponibilidad
   ========================================================== */
app.post("/api/calendar/search", async (req, res) => {
  try {
    const { fecha, ciudadOrigen, tipoFlete, metrosCubicos } = req.body;

    if (!fecha || !ciudadOrigen || !tipoFlete || !metrosCubicos) {
      return res.status(400).json({ ok: false, error: "Faltan parámetros" });
    }

    console.log("📅 POST /api/calendar/search:", req.body);

    // Aquí puedes usar la misma lógica del GET existente (por ejemplo):
    const calendarData = await obtenerCalendarioDisponible(
      fecha,
      ciudadOrigen,
      tipoFlete,
      metrosCubicos
    );

    if (!calendarData) {
      return res.status(404).json({ ok: false, error: "Sin disponibilidad" });
    }

    res.json({ ok: true, calendar: calendarData });
  } catch (error) {
    console.error("❌ Error en POST /api/calendar/search:", error);
    res.status(500).json({ ok: false, error: "Error interno del servidor" });
  }
});

// ---------- Servidor ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Tu Akarreo API corriendo en puerto ${PORT}`));
