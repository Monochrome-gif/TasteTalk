const restaurants = [];

const $ = selector => document.querySelector(selector);

const grid = $("#restaurantGrid");
const feed = $("#reviewFeed");
const searchInput = $("#searchInput");
const cuisineFilter = $("#cuisineFilter");
const dialog = $("#reviewDialog");
const readDialog = $("#readDialog");

let activeCuisine = "all";
let showFavoritesOnly = false;
let chosenRating = 5;

// Every review shared on ForkScore, oldest first. The server is the source of truth.
let reviews = [];
// "connecting" | "live" | "reconnecting" | "local" (offline demo: saved in this browser only)
let mode = "connecting";
let submitting = false;
let openRestaurant = null;      // { key, name } while the reviews dialog is open
const freshIds = new Set();     // reviews that just arrived (highlighted for a few seconds)

function loadData(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : fallback;
  } catch {
    return fallback;
  }
}

let favorites = loadData("forkscore-favorites", []);

function saveData(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    toast("Could not save data in this browser.");
    return false;
  }
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

/* ---------- Small helpers ---------- */

const keyOf = name => String(name).trim().toLowerCase().replace(/\s+/g, " ");

// Stable number for restaurants that people add by reviewing them (keeps favorites working).
function hashId(text) {
  let hash = 5381;
  for (const char of text) hash = ((hash * 33) ^ char.codePointAt(0)) >>> 0;
  return 100000 + (hash % 900000000);
}

const stars = rating => "★".repeat(rating) + "☆".repeat(5 - rating);

function timeAgo(iso) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/* ---------- Reviews ---------- */

const byDate = (a, b) => a.createdAt.localeCompare(b.createdAt);

function normalizeReview(raw) {
  if (!raw || typeof raw.restaurant !== "string" || !Number.isFinite(Number(raw.rating))) return null;
  const created = typeof raw.createdAt === "string" && !Number.isNaN(Date.parse(raw.createdAt))
    ? raw.createdAt
    : new Date(0).toISOString();
  return {
    id: String(raw.id ?? `${raw.restaurant}-${created}`),
    restaurant: raw.restaurant,
    reviewer: String(raw.reviewer || "Anonymous"),
    rating: Math.min(5, Math.max(1, Math.round(Number(raw.rating)))),
    text: String(raw.text || ""),
    createdAt: created
  };
}

function setReviews(list) {
  reviews = list.map(normalizeReview).filter(Boolean).sort(byDate);
}

// Adds a review if we don't have it yet. Returns the review when it was new, otherwise false.
function addReview(raw) {
  const review = normalizeReview(raw);
  if (!review || reviews.some(existing => existing.id === review.id)) return false;
  reviews.push(review);
  reviews.sort(byDate);
  return review;
}

function onIncoming(raw, isMine) {
  const review = addReview(raw);
  if (!review) return;

  freshIds.add(review.id);
  setTimeout(() => {
    freshIds.delete(review.id);
    renderFeed();
    renderReadDialog();
  }, 4500);

  refreshAll();
  if (!isMine && !submitting) {
    toast(`New review for ${review.restaurant} from ${review.reviewer}`);
  }
}

function onRemoved(id) {
  const before = reviews.length;
  reviews = reviews.filter(review => review.id !== String(id));
  if (reviews.length !== before) refreshAll();
}

/* ---------- Restaurants (ratings are worked out from the shared reviews) ---------- */

function getRestaurants() {
  const stats = new Map();
  reviews.forEach(review => {
    const key = keyOf(review.restaurant);
    const entry = stats.get(key) || { sum: 0, count: 0, name: review.restaurant };
    entry.sum += review.rating;
    entry.count += 1;
    stats.set(key, entry);
  });

  const average = entry => Number((entry.sum / entry.count).toFixed(1));
  const combined = [...restaurants, ...(window.forkscoreCountryRestaurants || [])]
    .map(restaurant => ({ ...restaurant }));
  const known = new Set();

  combined.forEach(restaurant => {
    const key = keyOf(restaurant.name);
    const entry = stats.get(key);
    known.add(key);
    restaurant.rating = entry ? average(entry) : 0;
    restaurant.reviews = entry ? entry.count : 0;
  });

  // Anyone can review a place that isn't listed yet; it then appears as a community restaurant.
  stats.forEach((entry, key) => {
    if (known.has(key)) return;
    combined.push({
      id: hashId(key),
      name: entry.name,
      cuisine: "Other",
      location: "Location not provided",
      price: "—",
      rating: average(entry),
      reviews: entry.count,
      image: "",
      description: "Added by the ForkScore community"
    });
  });

  return combined;
}

function renderRestaurants() {
  const term = searchInput.value.trim().toLowerCase();
  const cuisine = activeCuisine !== "all"
    ? activeCuisine
    : cuisineFilter.value;

  const filtered = getRestaurants().filter(r => {
    const matchesSearch = [
      r.name, r.cuisine, r.location, r.description
    ].some(value => value.toLowerCase().includes(term));

    const matchesCuisine =
      cuisine === "all" || r.cuisine === cuisine;

    const matchesFavorite =
      !showFavoritesOnly || favorites.includes(r.id);

    return matchesSearch && matchesCuisine && matchesFavorite;
  });

  $("#resultsCount").textContent =
    `${filtered.length} restaurant${filtered.length === 1 ? "" : "s"} found`;

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <h3>No restaurants found</h3>
        <p>Try another search or change your filters.</p>
      </div>`;
    return;
  }

  grid.innerHTML = filtered.map(r => {
    // Real photo first; otherwise a cuisine-matched illustrative photo (restaurant-photos.js).
    const stockPhoto = r.image ? "" : (window.forkscorePhotoFor ? window.forkscorePhotoFor(r) : "");
    const photo = r.image || stockPhoto;

    return `
    <article class="restaurant-card">
      <div class="card-image-wrap">
        ${photo ? `<img class="card-image" src="${escapeHTML(photo)}" alt="${escapeHTML(stockPhoto ? `${r.cuisine} food and dining, illustrative photo` : `${r.name} restaurant photo`)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.hidden=true; this.nextElementSibling.hidden=false; this.parentElement.classList.add('no-photo')">` : ""}
        <div class="photo-placeholder" ${photo ? "hidden" : ""} aria-label="Restaurant photo not available">
          <span class="photo-placeholder-icon">🍽</span>
          <span>Restaurant photo not available yet</span>
        </div>
        ${stockPhoto ? `<span class="stock-badge" title="A stock photo that matches this cuisine, not a photo of this restaurant">Illustrative photo</span>` : ""}
        <span class="price">${escapeHTML(r.price)}</span>
        <button class="favorite-btn ${favorites.includes(r.id) ? "saved" : ""}"
          data-favorite="${r.id}"
          aria-label="${favorites.includes(r.id) ? "Remove from" : "Add to"} favorites"
          aria-pressed="${favorites.includes(r.id)}">
          ${favorites.includes(r.id) ? "♥" : "♡"}
        </button>
      </div>
      <div class="card-content">
        <div class="card-title-row">
          <h3>${escapeHTML(r.name)}</h3>
          <span class="rating">${r.reviews > 0 ? `★ ${Number(r.rating).toFixed(1)}` : "☆ New"}</span>
        </div>
        <p class="card-meta">${escapeHTML(r.cuisine)} · ${escapeHTML(r.location)}</p>
        <p class="card-meta">${escapeHTML(r.description)}</p>
        ${r.imageSource ? `<p class="card-meta"><a href="${escapeHTML(r.imageSource)}" target="_blank" rel="noopener noreferrer">Photo source ↗</a></p>` : ""}
        ${r.website ? `<p class="card-meta"><a href="${escapeHTML(r.website)}" target="_blank" rel="noopener noreferrer">Official website ↗</a></p>` : ""}
        <div class="card-bottom">
          <button class="read-link" data-read="${r.id}">💬 ${r.reviews} ForkScore review${r.reviews === 1 ? "" : "s"}</button>
          <button class="rate-link" data-rate="${r.id}">Rate this ↗</button>
        </div>
      </div>
    </article>
  `;
  }).join("");
}

/* ---------- Live feed and the per-restaurant reviews dialog ---------- */

function reviewHTML(review, showRestaurant) {
  return `
    <article class="review-item${freshIds.has(review.id) ? " fresh" : ""}">
      <div class="review-top">
        <strong>${escapeHTML(review.reviewer)}</strong>
        <span class="stars" role="img" aria-label="${review.rating} out of 5 stars">${stars(review.rating)}</span>
      </div>
      ${showRestaurant ? `<p class="review-for">${escapeHTML(review.restaurant)}</p>` : ""}
      <p class="review-text">${escapeHTML(review.text)}</p>
      <time datetime="${escapeHTML(review.createdAt)}">${escapeHTML(timeAgo(review.createdAt))}</time>
    </article>`;
}

function renderFeed() {
  const latest = [...reviews].reverse().slice(0, 6);
  feed.innerHTML = latest.length
    ? latest.map(review => reviewHTML(review, true)).join("")
    : `<div class="empty-state">
         <h3>No reviews yet</h3>
         <p>Be the first to share your experience. It will show up here instantly for everyone.</p>
       </div>`;
}

function renderReadDialog() {
  if (!openRestaurant) return;
  const list = reviews.filter(review => keyOf(review.restaurant) === openRestaurant.key);
  const average = list.length
    ? (list.reduce((sum, review) => sum + review.rating, 0) / list.length).toFixed(1)
    : "";

  $("#readTitle").textContent = openRestaurant.name;
  $("#readSummary").textContent = list.length
    ? `★ ${average} · ${list.length} review${list.length === 1 ? "" : "s"}`
    : "No reviews yet";
  $("#readList").innerHTML = list.length
    ? [...list].reverse().map(review => reviewHTML(review, false)).join("")
    : `<p class="empty-note">Nobody has reviewed this place yet. Be the first!</p>`;
}

function openReadDialog(restaurant) {
  openRestaurant = { key: keyOf(restaurant.name), name: restaurant.name };
  renderReadDialog();
  readDialog.showModal();
}

function renderRestaurantList() {
  $("#restaurantList").innerHTML = getRestaurants()
    .map(restaurant => `<option value="${escapeHTML(restaurant.name)}"></option>`)
    .join("");
}

function refreshAll() {
  renderRestaurants();
  renderFeed();
  renderReadDialog();
  renderRestaurantList();
}

/* ---------- Connection: load, post and receive reviews in real time ---------- */

const STATUS_TEXT = {
  connecting: "Connecting…",
  live: "Live: new reviews appear instantly",
  reconnecting: "Reconnecting…",
  local: "Offline demo: reviews stay in this browser"
};

function setMode(next) {
  mode = next;
  const status = $("#liveStatus");
  status.textContent = STATUS_TEXT[next];
  status.className = `live-status is-${next}`;
  $("#formNote").textContent = next === "local"
    ? "Demo mode: reviews are stored in this browser only."
    : "Reviews are public. Everyone on ForkScore can see them live.";
}

async function fetchReviews() {
  const response = await fetch("/api/reviews", { cache: "no-store" });
  if (!response.ok) throw new Error(`Server answered ${response.status}`);
  const data = await response.json();
  if (!data || !Array.isArray(data.reviews)) throw new Error("Unexpected response");
  return data.reviews;
}

// Catches up with anything missed (after a dropped connection, or when polling).
async function syncReviews() {
  const latest = await fetchReviews();
  const knownIds = new Set(reviews.map(review => review.id));
  const changed = latest.length !== reviews.length ||
    latest.some(review => !knownIds.has(String(review.id)));
  if (changed) {
    setReviews(latest);
    refreshAll();
  }
}

let source = null;
let connectedBefore = false;

function connectLive() {
  if (source) source.close();

  if (!("EventSource" in window)) {
    // Very old browsers: check for new reviews every few seconds instead.
    setMode("live");
    setInterval(() => syncReviews().catch(() => {}), 5000);
    return;
  }

  source = new EventSource("/api/events");

  source.addEventListener("open", () => {
    setMode("live");
    if (connectedBefore) syncReviews().catch(() => {});
    connectedBefore = true;
  });

  source.addEventListener("review", event => {
    try { onIncoming(JSON.parse(event.data), false); } catch { /* ignore a malformed event */ }
  });

  source.addEventListener("remove", event => {
    try { onRemoved(JSON.parse(event.data).id); } catch { /* ignore a malformed event */ }
  });

  source.addEventListener("error", () => {
    if (mode === "local") return;
    setMode("reconnecting");
    // The browser retries by itself; if it gave up, start a fresh connection.
    if (source.readyState === EventSource.CLOSED) setTimeout(connectLive, 5000);
  });
}

// Used when the page is opened without the server (for example by double-clicking index.html).
function startLocalMode() {
  if (source) source.close();
  setMode("local");
  setReviews(loadData("forkscore-reviews", []));
  refreshAll();
}

async function startUp() {
  try {
    setReviews(await fetchReviews());
    refreshAll();
    connectLive();
  } catch {
    startLocalMode();
  }
}

async function publishReview(data) {
  if (mode === "local") {
    const review = { id: `local-${Date.now()}`, ...data, createdAt: new Date().toISOString() };
    if (!saveData("forkscore-reviews", [...reviews, review])) {
      throw new Error("Could not save your review in this browser.");
    }
    return review;
  }

  let response;
  try {
    response = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
  } catch {
    throw new Error("Can't reach ForkScore right now. Check your connection and try again.");
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Could not publish your review. Please try again.");
  return body.review;
}

/* ---------- Page interactions ---------- */

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2800);
}

function setCuisine(cuisine) {
  activeCuisine = cuisine;
  showFavoritesOnly = cuisine === "favorites";

  if (cuisine !== "all" && cuisine !== "favorites") {
    cuisineFilter.value = "all";
  }

  document.querySelectorAll(".chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.cuisine === cuisine);
  });

  renderRestaurants();
}

function openReview(restaurantName = "") {
  $("#restaurantName").value = restaurantName;
  chosenRating = 5;
  updateStars();
  dialog.showModal();
}

function updateStars() {
  document.querySelectorAll("[data-star]").forEach(button => {
    const selected = Number(button.dataset.star) <= chosenRating;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

grid.addEventListener("click", event => {
  const favoriteButton = event.target.closest("[data-favorite]");
  const rateButton = event.target.closest("[data-rate]");
  const readButton = event.target.closest("[data-read]");

  if (favoriteButton) {
    const id = Number(favoriteButton.dataset.favorite);

    favorites = favorites.includes(id)
      ? favorites.filter(favorite => favorite !== id)
      : [...favorites, id];

    saveData("forkscore-favorites", favorites);
    renderRestaurants();
  }

  if (rateButton) {
    const restaurant = getRestaurants().find(
      r => r.id === Number(rateButton.dataset.rate)
    );
    if (restaurant) openReview(restaurant.name);
  }

  if (readButton) {
    const restaurant = getRestaurants().find(
      r => r.id === Number(readButton.dataset.read)
    );
    if (restaurant) openReadDialog(restaurant);
  }
});

$("#cuisineChips").addEventListener("click", event => {
  const chip = event.target.closest("[data-cuisine]");
  if (chip) setCuisine(chip.dataset.cuisine);
});

searchInput.addEventListener("input", renderRestaurants);

$("#searchForm").addEventListener("submit", event => {
  event.preventDefault();
  activeCuisine = "all";
  showFavoritesOnly = false;
  document.querySelectorAll(".chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.cuisine === "all");
  });
  renderRestaurants();
});

cuisineFilter.addEventListener("change", () => {
  activeCuisine = "all";
  showFavoritesOnly = false;
  document.querySelectorAll(".chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.cuisine === "all");
  });
  renderRestaurants();
});

$("#showAll").addEventListener("click", () => {
  searchInput.value = "";
  cuisineFilter.value = "all";
  setCuisine("all");
});

$("#openReview").addEventListener("click", () => openReview());
$("#ctaReview").addEventListener("click", () => openReview());
$("#closeDialog").addEventListener("click", () => dialog.close());

$("#closeRead").addEventListener("click", () => readDialog.close());
readDialog.addEventListener("close", () => { openRestaurant = null; });
$("#readWrite").addEventListener("click", () => {
  const name = openRestaurant ? openRestaurant.name : "";
  readDialog.close();
  openReview(name);
});

$("#starPicker").addEventListener("click", event => {
  const button = event.target.closest("[data-star]");
  if (!button) return;
  chosenRating = Number(button.dataset.star);
  updateStars();
});

$("#reviewForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (submitting) return;

  const form = event.target;
  const restaurant = $("#restaurantName").value.trim();
  const reviewer = $("#reviewerName").value.trim();
  const reviewText = $("#reviewText").value.trim();

  if (!restaurant || !reviewer || !reviewText) return;

  const submitButton = form.querySelector(".submit-btn");
  submitting = true;
  submitButton.disabled = true;
  submitButton.textContent = "Publishing…";

  try {
    const review = await publishReview({
      restaurant,
      reviewer,
      rating: chosenRating,
      text: reviewText
    });

    onIncoming(review, true);
    dialog.close();
    form.reset();
    chosenRating = 5;
    updateStars();
    toast(mode === "local"
      ? `Thanks, ${reviewer}! Your review is saved in this browser (offline demo).`
      : `Thanks, ${reviewer}! Your review is live.`);
  } catch (error) {
    toast(error.message || "Could not publish your review. Please try again.");
  } finally {
    submitting = false;
    submitButton.disabled = false;
    submitButton.textContent = "Publish review";
  }
});

$("#year").textContent = new Date().getFullYear();

// "2 min ago" labels stay fresh while the page is open.
setInterval(() => {
  renderFeed();
  renderReadDialog();
}, 30000);

updateStars();
setMode("connecting");
refreshAll();
startUp();
