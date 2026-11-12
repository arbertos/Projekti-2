/**
 * Junatutka – rautatieasemien reaaliaikaiset aikataulut
 * Datalähde: Digitraffic rautatieliikenteen avoin REST-rajapinta
 * https://rata.digitraffic.fi/api/v1
 *
 * Vain natiivi JavaScript
 * lisätään dynaamisesti addEventListenerillä – HTML:ssä ei ole onclick-attribuutteja.
 */
"use strict";

/* ===== Vakiot ===== */
const API_BASE = "https://rata.digitraffic.fi/api/v1";
const REFRESH_INTERVAL_MS = 60 * 1000; // automaattinen päivitys minuutin välein

/* ===== Sovelluksen tila ===== */
const state = {
  stations: [],          // henkilöliikenneasemat [{ code, name }]
  stationNames: {},      // hakutaulu lyhenne -> nimi, esim. "HKI" -> "Helsinki"
  currentStation: null,  // valittu asema { code, name }
  refreshTimer: null     // setInterval-ajastimen tunniste
};

/* ===== DOM-elementit ===== */
const el = {
  form: document.getElementById("search-form"),
  search: document.getElementById("station-search"),
  datalist: document.getElementById("station-list"),
  select: document.getElementById("station-select"),
  count: document.getElementById("count-select"),
  type: document.getElementById("type-select"),
  button: document.getElementById("search-btn"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  resultsTitle: document.getElementById("results-title"),
  resultsMeta: document.getElementById("results-meta"),
  autoRefresh: document.getElementById("auto-refresh"),
  trainList: document.getElementById("train-list"),
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modal-title"),
  modalMeta: document.getElementById("modal-meta"),
  routeList: document.getElementById("route-list")
};

/* =====================================================================
 *  1. AJAX-apufunktio
 * ===================================================================== */

/**
 * Hakee JSON-datan annetusta osoitteesta fetch-rajapinnalla (AJAX).
 * Heittää virheen, jos palvelin vastaa virhekoodilla.
 */
async function fetchJSON(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Palvelin vastasi virheellä ${response.status}`);
  }
  return response.json();
}

/* =====================================================================
 *  2. Asemien lataus (metadata)
 * ===================================================================== */

/** Lataa asemat, suodattaa henkilöliikenneasemat ja täyttää valikot. */
async function loadStations() {
  showStatus("Ladataan asemalistaa…", true);
  try {
    const data = await fetchJSON(`${API_BASE}/metadata/stations`);

    // Tallennetaan kaikkien asemien nimet hakutauluun (tarvitaan lähtö-/määränpään nimiin)
    data.forEach((s) => {
      state.stationNames[s.stationShortCode] = cleanName(s.stationName);
    });

    // Valitaan vain suomalaiset asemat, joilla on henkilöliikennettä
    state.stations = data
      .filter((s) => s.passengerTraffic && s.countryCode === "FI")
      .map((s) => ({ code: s.stationShortCode, name: cleanName(s.stationName) }))
      .sort((a, b) => a.name.localeCompare(b.name, "fi"));

    fillStationControls();
    showStatus("");

    // Jos osoitteessa on asemakoodi (#TPE), haetaan se suoraan
    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (fromHash && findStation(fromHash)) {
      selectStation(findStation(fromHash));
      loadTrains();
    }
  } catch (err) {
    showError("Asemalistan lataus epäonnistui. Tarkista verkkoyhteys ja päivitä sivu. (" + err.message + ")");
  }
}

/** Poistaa nimestä turhan " asema"-päätteen: "Helsinki asema" -> "Helsinki". */
function cleanName(name) {
  return name.replace(/ asema$/i, "").trim();
}

/** Täyttää pudotusvalikon ja hakukentän ehdotuslistan asemilla. */
function fillStationControls() {
  const selectFrag = document.createDocumentFragment();
  const listFrag = document.createDocumentFragment();

  const placeholder = new Option("Valitse asema", "");
  selectFrag.appendChild(placeholder);

  state.stations.forEach((s) => {
    selectFrag.appendChild(new Option(`${s.name} (${s.code})`, s.code));
    const opt = document.createElement("option");
    opt.value = s.name;
    listFrag.appendChild(opt);
  });

  el.select.replaceChildren(selectFrag);
  el.datalist.replaceChildren(listFrag);
  el.select.disabled = false;
}

/**
 * Etsii aseman hakusanalla: ensin tarkka osuma nimeen tai lyhenteeseen,
 * sitten alkuosa ja lopuksi mikä tahansa osuma nimen sisällä.
 */
function findStation(query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return (
    state.stations.find((s) => s.name.toLowerCase() === q || s.code.toLowerCase() === q) ||
    state.stations.find((s) => s.name.toLowerCase().startsWith(q)) ||
    state.stations.find((s) => s.name.toLowerCase().includes(q)) ||
    null
  );
}

/** Asettaa valitun aseman ja synkronoi hakukentän ja valikon. */
function selectStation(station) {
  state.currentStation = station;
  el.select.value = station.code;
  el.search.value = station.name;
  history.replaceState(null, "", "#" + station.code);
}

/* =====================================================================
 *  3. Junien haku valitulle asemalle
 * ===================================================================== */

/** Hakee aseman lähtevät tai saapuvat junat ja näyttää ne. */
async function loadTrains({ silent = false } = {}) {
  const station = state.currentStation;
  if (!station) {
    showError("Valitse ensin asema listasta tai kirjoita aseman nimi.");
    return;
  }

  const direction = document.querySelector('input[name="direction"]:checked').value;
  const count = Number(el.count.value);
  const typeFilter = el.type.value;

  // Haetaan reilusti ylimääräisiä, koska osa suodatetaan pois (tavarajunat, junatyyppi)
  const fetchCount = count * 2;
  const params = new URLSearchParams({
    arrived_trains: 0,
    arriving_trains: direction === "ARRIVAL" ? fetchCount : 0,
    departed_trains: 0,
    departing_trains: direction === "DEPARTURE" ? fetchCount : 0,
    include_nonstopping: false
  });

  if (!silent) showStatus(`Haetaan junia asemalta ${station.name}…`, true);
  el.button.disabled = true;

  try {
    const trains = await fetchJSON(`${API_BASE}/live-trains/station/${station.code}?${params}`);

    // Muokataan raakadata näytettävään muotoon ja valitaan tarvittavat kentät
    const rows = trains
      .map((train) => toDisplayRow(train, station.code, direction))
      .filter(Boolean)
      .filter((r) => typeFilter === "all" || r.category === typeFilter)
      .sort((a, b) => a.scheduled - b.scheduled)
      .slice(0, count);

    renderTrains(rows, station, direction);
    showStatus("");
  } catch (err) {
    showError("Junien haku epäonnistui: " + err.message);
  } finally {
    el.button.disabled = false;
  }
}

/**
 * Poimii junasta valitun aseman aikataulurivin ja muodostaa siitä
 * yksinkertaisen olion näyttämistä varten. Palauttaa null, jos juna
 * ei sovi listaan (esim. tavarajuna tai jo lähtenyt).
 */
function toDisplayRow(train, stationCode, direction) {
  // Vain henkilöjunat
  if (train.trainCategory !== "Commuter" && train.trainCategory !== "Long-distance") return null;

  const rows = train.timeTableRows;
  const stop = rows.find(
    (r) => r.stationShortCode === stationCode && r.type === direction && r.trainStopping && r.commercialStop
  );
  if (!stop || stop.actualTime) return null; // ei pysähdy tai on jo mennyt

  const first = rows[0];
  const last = rows[rows.length - 1];
  const scheduled = new Date(stop.scheduledTime);
  const estimate = stop.liveEstimateTime ? new Date(stop.liveEstimateTime) : null;
  const delay = stop.differenceInMinutes || 0;

  return {
    trainNumber: train.trainNumber,
    departureDate: train.departureDate,
    category: train.trainCategory,
    // Lähijunille näytetään linjatunnus (esim. "R"), muille tyyppi + numero (esim. "IC 27")
    label: train.commuterLineID || `${train.trainType} ${train.trainNumber}`,
    fullName: `${train.trainType} ${train.trainNumber}`,
    origin: stationName(first.stationShortCode),
    destination: stationName(last.stationShortCode),
    scheduled,
    estimate,
    delay,
    track: stop.commercialTrack || "–",
    cancelled: train.cancelled || stop.cancelled
  };
}

/** Palauttaa aseman nimen lyhenteen perusteella. */
function stationName(code) {
  return state.stationNames[code] || code;
}

/** Muotoilee ajan muotoon HH.MM suomalaisittain. */
function formatTime(date) {
  return date.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
}

/* =====================================================================
 *  4. Tulosten näyttäminen
 * ===================================================================== */

/** Piirtää junakortit listaan. */
function renderTrains(rows, station, direction) {
  const isDeparture = direction === "DEPARTURE";
  el.results.hidden = false;
  el.resultsTitle.textContent = `${isDeparture ? "Lähtevät" : "Saapuvat"} junat – ${station.name}`;
  el.resultsMeta.textContent = `Päivitetty klo ${formatTime(new Date())} · ${rows.length} junaa · klikkaa junaa nähdäksesi reitin`;

  el.trainList.replaceChildren();

  if (rows.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Ei tulevia junia valituilla hakuehdoilla.";
    el.trainList.appendChild(li);
    return;
  }

  rows.forEach((r) => el.trainList.appendChild(createTrainCard(r, isDeparture)));
}

/** Luo yhden junan kortin DOM-elementtinä. */
function createTrainCard(r, isDeparture) {
  const li = document.createElement("li");
  li.className = "train-card";
  li.tabIndex = 0; // kortti on valittavissa myös näppäimistöllä
  li.dataset.number = r.trainNumber;
  li.dataset.date = r.departureDate;
  if (r.cancelled) li.classList.add("is-cancelled");
  else if (r.delay > 0) li.classList.add("is-late");

  // Aika: jos juna on myöhässä, näytetään arvioitu aika ja yliviivattu alkuperäinen
  const timeCol = document.createElement("div");
  timeCol.className = "time";
  if (r.delay > 0 && r.estimate && !r.cancelled) {
    timeCol.innerHTML = `${formatTime(r.estimate)}<span class="old">${formatTime(r.scheduled)}</span>`;
  } else {
    timeCol.textContent = formatTime(r.scheduled);
  }

  // Linjatunnus / junatyyppi
  const badgeCol = document.createElement("div");
  badgeCol.className = "badge-col";
  const badge = document.createElement("span");
  badge.className = "badge" + (r.category === "Long-distance" ? " long" : "");
  badge.textContent = r.label;
  badgeCol.appendChild(badge);

  // Määränpää (lähtevät) tai lähtöasema (saapuvat)
  const infoCol = document.createElement("div");
  const dest = document.createElement("div");
  dest.className = "destination";
  dest.textContent = isDeparture ? r.destination : `Saapuu asemalta ${r.origin}`;
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = `${r.fullName} · ${r.origin} → ${r.destination}`;
  infoCol.append(dest, sub);

  // Raide ja tila
  const rightCol = document.createElement("div");
  rightCol.className = "right";
  const track = document.createElement("div");
  track.className = "track";
  track.innerHTML = `Raide<strong></strong>`;
  track.querySelector("strong").textContent = r.track;
  const stateEl = document.createElement("div");
  if (r.cancelled) {
    stateEl.className = "state cancel";
    stateEl.textContent = "Peruttu";
  } else if (r.delay > 0) {
    stateEl.className = "state late";
    stateEl.textContent = `+${r.delay} min`;
  } else {
    stateEl.className = "state ontime";
    stateEl.textContent = "Ajallaan";
  }
  rightCol.append(track, stateEl);

  li.append(timeCol, badgeCol, infoCol, rightCol);
  return li;
}

/* =====================================================================
 *  5. Junan reittinäkymä (modaali)
 * ===================================================================== */

/** Hakee yksittäisen junan koko reitin ja näyttää sen modaalissa. */
async function openTrainRoute(trainNumber, departureDate) {
  el.modal.hidden = false;
  el.modalTitle.textContent = `Juna ${trainNumber}`;
  el.modalMeta.innerHTML = `<span class="spinner"></span>Ladataan reittiä…`;
  el.routeList.replaceChildren();

  try {
    const data = await fetchJSON(`${API_BASE}/trains/${departureDate}/${trainNumber}`);
    const train = data[0];
    if (!train) throw new Error("Junaa ei löytynyt");

    el.modalTitle.textContent = train.commuterLineID
      ? `${train.commuterLineID}-juna (${train.trainType} ${train.trainNumber})`
      : `${train.trainType} ${train.trainNumber}`;

    // Näytetään vain asemat, joilla juna pysähtyy matkustajia varten.
    // Jokaisella välipysäkillä on sekä ARRIVAL- että DEPARTURE-rivi, joten
    // otetaan aseman ensimmäinen rivi ja lähtöaika, jos sellainen on.
    const stops = [];
    train.timeTableRows.forEach((row) => {
      if (!row.trainStopping || !row.commercialStop) return;
      const prev = stops[stops.length - 1];
      if (prev && prev.code === row.stationShortCode) {
        prev.row = row; // korvataan saapumisrivi lähtörivillä
      } else {
        stops.push({ code: row.stationShortCode, row });
      }
    });

    const first = stops[0];
    const last = stops[stops.length - 1];
    el.modalMeta.textContent = `${stationName(first.code)} → ${stationName(last.code)} · ${stops.length} pysähdystä`;

    // Etsitään ensimmäinen asema, jota juna ei ole vielä ohittanut
    const nextIndex = stops.findIndex((s) => !s.row.actualTime);

    // Tyhjennetään lista vasta datan saavuttua (estää tuplat, jos klikataan nopeasti useasti)
    el.routeList.replaceChildren();

    stops.forEach((s, i) => {
      const li = document.createElement("li");
      if (s.row.actualTime) li.classList.add("passed");
      if (i === nextIndex && train.runningCurrently) li.classList.add("current");
      if (state.currentStation && s.code === state.currentStation.code) li.classList.add("current");

      const name = document.createElement("span");
      name.textContent = stationName(s.code);
      const time = document.createElement("span");
      time.className = "rtime";
      const t = s.row.actualTime || s.row.liveEstimateTime || s.row.scheduledTime;
      const diff = s.row.differenceInMinutes;
      time.textContent = formatTime(new Date(t)) + (diff > 0 ? ` (+${diff})` : "");

      // Ensimmäinen grid-sarake on CSS:n ::before-pallo, joten lisätään vain nimi ja aika
      li.append(name, time);
      el.routeList.appendChild(li);
    });
  } catch (err) {
    el.modalMeta.textContent = "Reitin lataus epäonnistui: " + err.message;
  }
}

/** Sulkee modaalin. */
function closeModal() {
  el.modal.hidden = true;
}

/* =====================================================================
 *  6. Tila-ilmoitukset ja automaattinen päivitys
 * ===================================================================== */

function showStatus(message, loading = false) {
  el.status.className = "status";
  el.status.innerHTML = loading ? `<span class="spinner"></span>` : "";
  el.status.append(message);
}

function showError(message) {
  el.status.className = "status error";
  el.status.textContent = message;
}

/** Käynnistää tai pysäyttää automaattisen päivityksen valintaruudun mukaan. */
function updateAutoRefresh() {
  clearInterval(state.refreshTimer);
  if (el.autoRefresh.checked) {
    state.refreshTimer = setInterval(() => {
      if (state.currentStation) loadTrains({ silent: true });
    }, REFRESH_INTERVAL_MS);
  }
}

/* =====================================================================
 *  7. Tapahtumankäsittelijät (lisätään dynaamisesti)
 * ===================================================================== */

function addEventHandlers() {
  // Lomakkeen lähetys: etsitään asema hakukentästä ja haetaan junat
  el.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const station = findStation(el.search.value) || findStation(el.select.value);
    if (!station) {
      showError(`Asemaa "${el.search.value}" ei löytynyt. Kokeile toista hakusanaa.`);
      return;
    }
    selectStation(station);
    loadTrains();
  });

  // Ehdotuslistasta valinta (datalist) käynnistää haun heti
  el.search.addEventListener("change", () => {
    const station = findStation(el.search.value);
    if (station) {
      selectStation(station);
      loadTrains();
    }
  });

  // Pudotusvalikon valinta käynnistää haun heti
  el.select.addEventListener("change", () => {
    const station = findStation(el.select.value);
    if (station) {
      selectStation(station);
      loadTrains();
    }
  });

  // Suunnan, määrän tai junatyypin vaihto päivittää listan, jos asema on valittu
  document.querySelectorAll('input[name="direction"]').forEach((radio) =>
    radio.addEventListener("change", () => state.currentStation && loadTrains())
  );
  el.count.addEventListener("change", () => state.currentStation && loadTrains());
  el.type.addEventListener("change", () => state.currentStation && loadTrains());

  // Automaattinen päivitys päälle/pois
  el.autoRefresh.addEventListener("change", updateAutoRefresh);

  // Junakortin klikkaus avaa reitin (tapahtumadelegointi: yksi käsittelijä listalle)
  el.trainList.addEventListener("click", (e) => {
    const card = e.target.closest(".train-card");
    if (card) openTrainRoute(card.dataset.number, card.dataset.date);
  });
  el.trainList.addEventListener("keydown", (e) => {
    const card = e.target.closest(".train-card");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openTrainRoute(card.dataset.number, card.dataset.date);
    }
  });

  // Modaalin sulkeminen: taustan tai ×-napin klikkaus sekä Esc-näppäin
  el.modal.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", closeModal));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.modal.hidden) closeModal();
  });
}

/* =====================================================================
 *  Käynnistys
 * ===================================================================== */
document.addEventListener("DOMContentLoaded", () => {
  addEventHandlers();
  updateAutoRefresh();
  loadStations();
});