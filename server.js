/**
 * server.js
 * Tu Akarreo - API de disponibilidad y reservas (Google Calendar)
 *
 * Requerimientos:
 * - credentials.json (Service Account) en la raíz del proyecto (Render: use Secret File path)
 * - Deploy en Render / Railway / similar
 */

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors()); // en producción restringe origin a tu dominio
app.use(bodyParser.json());

// ---------- Autenticación Google ----------
const keyFilePath = process.env.GOOGLE_CREDENTIALS_PATH || path.join(__dirname, "credentials.json");

const auth = new google.auth.GoogleAuth({
  keyFile: keyFilePath,
  scopes: ["https://www.googleapis.com/auth/calendar"]
});

const calendar = google.calendar({ version: "v3", auth });

// ---------- Reglas de duración (horas) ----------
function duracionPorTipoYVolumen(tipoFlete = "", metrosCubicos = 0) {
  const tipo = (tipoFlete || "").toLowerCase();
  if (tipo.includes("mobiliario") || tipo.includes("mercancia") && tipo.includes("mobiliario")) {
    // cargue 20 minutos (0.33h)
    return 0.3333333;
  }

  // basada en la tabla que diste (horas)
  const m = parseFloat(metrosCubicos || 0);
  if (tipo.includes("mudanza")) {
    if (m <= 7.5) return 2;
    if (m <= 12) return 2.5;
    if (m <= 17) return 3;
    if (m <= 26) return 4;
    if (m <= 33) return 5;
    return 6;
  }

  // por defecto 1 hora
  return 1;
}

// estimación simple de desplazamiento (horas) a partir de distancia en km (fallback si no hay distancia)
function estimarDesplazamientoHoras(distanciaKm = null) {
  if (distanciaKm && !isNaN(distanciaKm)) {
    const velocidadProm = 35; // km/h (valor estimado urbano)
    return distanciaKm / velocidadProm;
  }
  // fallback conservador
  return 0.5;
}

// HORA OPERATIVA: rango para buscar slots
const OPERATIVE_START_HOUR = 6; // 06:00
const OPERATIVE_END_HOUR = 20; // 20:00

// ---------- Helper: convierte "YYYY-MM-DD" y hora hh:mm into Date object (America/Bogota offset handled via ISO) ----------
function isoFromDateTimeLocal(fechaYYYYMMDD, horaHHMM) {
  // produce e.g. "2025-11-03T08:00:00-05:00"
  return new Date(`${fechaYYYYMMDD}T${horaHHMM}:00-05:00`);
}

// ---------- Endpoint: buscar disponibilidad ----------
/**
 * POST /api/calendar/search
 * body: { fecha: "YYYY-MM-DD", ciudadOrigen: "Pereira", metrosCubicos: number, tipoFlete: "mudanza" }
 * response: { available: boolean, calendar: { calendarId, calendarCode, vehicleType, maxM3, availableSlots: [ISO strings] } }
 */
app.post("/api/calendar/search", async (req, res) => {
  try {
    const { fecha, ciudadOrigen = "", metrosCubicos = 0, tipoFlete = "" } = req.body;
    if (!fecha) return res.status(400).json({ error: "Falta fecha (YYYY-MM-DD)" });

    console.log("Search:", fecha, ciudadOrigen, tipoFlete, metrosCubicos);

    // obtener lista de calendarios de la cuenta
    const listRes = await calendar.calendarList.list();
    const calendars = listRes.data.items || [];

    // filtramos por resumen que incluya la ciudad y que no esté Inactivo / Pausado
    const candidates = calendars.filter(c => {
      const s = (c.summary || "").toLowerCase();
      if (!s) return false;
      if (ciudadOrigen && !s.includes(ciudadOrigen.toLowerCase())) return false;
      if (s.includes("inactivo") || s.includes("pausado")) return false;
      // opcional: solo calendarios con "tu-a" o "tu-"
      // if (!s.includes("tu-a")) return false;
      return true;
    });

    // slots base: iterar desde OPERATIVE_START_HOUR hasta END, salto cada 30 min
    const slotsBase = [];
    for (let h = OPERATIVE_START_HOUR; h <= OPERATIVE_END_HOUR; h++) {
      for (let m of [0, 30]) {
        const hh = String(h).padStart(2, "0");
        const mm = String(m).padStart(2, "0");
        slotsBase.push(`${fecha}T${hh}:${mm}:00-05:00`);
      }
    }

    // revisar por cada calendario de candidatos en orden
    for (const cal of candidates) {
      // parsear info del summary: "ACTIVO / Ciudad / TU-A0001 / Furgon / 7m"
      const parts = (cal.summary || "").split("/").map(p => p.trim());
      const calendarCode = parts[2] || cal.summary;
      const vehicleType = parts[3] || "";
      const maxM3Match = (parts[4] || "").match(/([0-9]+(?:\.[0-9]+)?)/);
      const maxM3 = maxM3Match ? parseFloat(maxM3Match[1]) : 9999;

      if (maxM3 < parseFloat(metrosCubicos || 0)) {
        continue; // no tiene capacidad
      }

      // obtener eventos del día
      const timeMin = new Date(`${fecha}T00:00:00-05:00`).toISOString();
      const timeMax = new Date(`${fecha}T23:59:59-05:00`).toISOString();

      const evRes = await calendar.events.list({
        calendarId: cal.id,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime"
      });

      const events = evRes.data.items || [];

      // convertir events a intervalos [start, end]
      const booked = events.map(ev => {
        const s = ev.start.dateTime || ev.start.date; // ISO
        const e = ev.end.dateTime || ev.end.date;
        return { start: new Date(s), end: new Date(e) };
      });

      // Para cada slotBase, verificar solapamiento si reservamos con una duración "estándar" (p.ej. 2h default)
      // Aquí devolvemos slots basados en una duración estimada por tipo/m³ + traslado parcial (server reservará duración real)
      const estimatedServiceHours = duracionPorTipoYVolumen(tipoFlete, metrosCubicos);
      // consideramos slotEnd = slotStart + estimatedServiceHours + 1h buffer (el buffer solo al reservar; aquí usamos slot length = estimatedServiceHours)
      const availableSlots = [];

      for (const slotISO of slotsBase) {
        const slotStart = new Date(slotISO);
        const slotEnd = new Date(slotStart.getTime() + Math.round(estimatedServiceHours * 60 * 60 * 1000));
        // si sale del horario operativo, skip
        if (slotStart.getHours() < OPERATIVE_START_HOUR || slotEnd.getHours() > OPERATIVE_END_HOUR + 1) continue;

        // comprobar conflicto
        const conflict = booked.some(ev => slotStart < ev.end && slotEnd > ev.start);
        if (!conflict) {
          availableSlots.push(slotStart.toISOString());
        }
      }

      if (availableSlots.length > 0) {
        // devolvemos el primer calendario que tenga slots disponibles
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

    // sin candidatos disponibles
    return res.json({ available: false });

  } catch (err) {
    console.error("Error /api/calendar/search:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------- Endpoint: reservar (crea evento con duración calculada y buffer) ----------
/**
 * POST /api/calendar/reserve
 * body: {
 *   calendarId,
 *   fecha: "YYYY-MM-DD",
 *   slotISO: "2025-11-03T08:00:00-05:00",
 *   origen, destino,
 *   tipoFlete,
 *   metrosCubicos,
 *   distanciaKm (opcional),
 *   cliente: { nombre, email, telefono }
 * }
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
      return res.status(400).json({ error: "Faltan calendarId, fecha o slotISO" });
    }

    // 1) calcular duración: traslado + cargue/descargue + buffer (1h entre servicios si no es primer servicio)
    const duracionBase = duracionPorTipoYVolumen(tipoFlete, metrosCubicos); // horas
    const duracionTraslado = estimarDesplazamientoHoras(distanciaKm); // horas
    // determinar si es primer servicio del día (miramos eventos previos en calendar)
    const dayStart = new Date(`${fecha}T00:00:00-05:00`).toISOString();
    const slotStartDate = new Date(slotISO);
    const eventsBefore = await calendar.events.list({
      calendarId,
      timeMin: dayStart,
      timeMax: slotISO,
      singleEvents: true,
      orderBy: "startTime"
    });
    const prevEvents = eventsBefore.data.items || [];
    const esPrimerServicio = prevEvents.length === 0;
    const bufferHoras = esPrimerServicio ? 0 : 1;

    const duracionTotalHoras = duracionBase + duracionTraslado + bufferHoras;

    // 2) calcular end time
    const start = slotStartDate;
    const end = new Date(start.getTime() + Math.round(duracionTotalHoras * 60 * 60 * 1000));

    // 3) verificar que no haya conflicto en ese rango
    const evRes = await calendar.events.list({
      calendarId,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime"
    });
    const confEvents = evRes.data.items || [];
    if (confEvents.length > 0) {
      return res.status(409).json({ error: "El slot ya está ocupado (conflicto al reservar)." });
    }

    // 4) crear evento
    const event = {
      summary: `Reserva Tu Akarreo - ${cliente.nombre || "Cliente"}`,
      description:
        `Cliente: ${cliente.nombre || ""}\nTel: ${cliente.telefono || ""}\nEmail: ${cliente.email || ""}\n` +
        `Tipo: ${tipoFlete}\nM3: ${metrosCubicos}\nOrigen: ${origen}\nDestino: ${destino}\nDuración(h): ${duracionTotalHoras.toFixed(2)}`,
      start: { dateTime: start.toISOString(), timeZone: "America/Bogota" },
      end: { dateTime: end.toISOString(), timeZone: "America/Bogota" }
    };

    const insertRes = await calendar.events.insert({
      calendarId,
      requestBody: event
    });

    return res.json({
      success: true,
      reservation: {
        calendarId,
        start: start.toISOString(),
        end: end.toISOString(),
        eventId: insertRes.data.id,
        htmlLink: insertRes.data.htmlLink
      }
    });

  } catch (err) {
    console.error("Error /api/calendar/reserve:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------- Iniciar servidor ----------
const PORT = process.env.PORT || 10000; // Render asignará su puerto mediante env var
app.listen(PORT, () => console.log(`Tu Akarreo API corriendo en puerto ${PORT}`));
