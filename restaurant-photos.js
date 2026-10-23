/* ForkScore illustrative photo library.
 *
 * Restaurants that have no verified, restaurant-specific photo get a food/dining
 * photo that matches their cuisine. These are stock images, so the card shows an
 * "Illustrative photo" badge. To use a restaurant's real photo, add `image` (and
 * `imageSource`) to its entry in restaurants-by-country.js - that always wins.
 */
(function () {
  const U = (id, w = 900) =>
    `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=80`;

  // Photo pools per cuisine. Restaurants take the next photo in their pool,
  // so neighbouring cards of the same cuisine never look the same.
  const pools = {
    // 18 photos, so every Nigerian restaurant in the starter list gets a different one.
    // (The rice-dish photo is kept out of the rotation: it is reserved for Ofadaboy below.)
    Nigerian: [
      "1517248135467-4c7edcad34c4", // warm restaurant interior
      "1555939594-58d7cb561ad1",    // grilled skewers
      "1498837167922-ddd27525d352", // food spread
      "1574484284002-952d92456975", // rich stew
      "1529692236671-f1f6cf9683ba", // grilled meat
      "1555396273-367ea4eb4db5",    // dining room
      "1476224203421-9ac39bcb3327", // plated meal
      "1432139555190-58524dae6a55", // shared table
      "1466978913421-dad2ebd01d17", // restaurant lights
      "1585937421612-70a008356fbe", // spiced dish
      "1559339352-11d035aa65de",    // dining area
      "1504674900247-0877df9cc836", // plated food
      "1544148103-0773bf10d330",    // restaurant table
      "1493770348161-369560ae357d", // home-style spread
      "1550966871-3ed3cdb5ed0c",    // restaurant evening
      "1540189549336-e6e99c3679fe", // fresh plate
      "1565958011703-44f9829ba187", // dessert and sides
      "1559329007-40df8a9345d8"     // casual dining
    ],
    Asian: [
      "1569058242253-92a9c755a0ec", // Chinese dishes
      "1563245372-f21724e3856d",    // dumplings
      "1555126634-323283e090fa",    // noodle bowl
      "1569718212165-3a8278d5f624", // ramen
      "1579871494447-9811cf80d66c", // sushi
      "1559847844-5315695dadae"     // Asian plates
    ],
    International: [
      "1414235077428-338989a2e8c0", // fine dining
      "1424847651672-bf20a4b0982b", // set table
      "1519708227418-c8fd9a32b7a2", // seafood
      "1473093295043-cdd812d0e601", // pasta
      "1544025162-d76694265947",    // steak
      "1537047902294-62a40c20a6ae", // lounge bar
      "1552566626-52f8b828add9"     // modern interior
    ],
    Grill: [
      "1544025162-d76694265947",    // steak
      "1428515613728-6b4607e44363", // grill plate
      "1551782450-a2132b4ba21d",    // burger
      "1529692236671-f1f6cf9683ba", // grilled meat
      "1555939594-58d7cb561ad1",    // skewers
      "1467003909585-2f8a72700288"  // grilled fish
    ],
    "Fast Food": [
      "1568901346375-23c9450c58cd", // burger
      "1551782450-a2132b4ba21d",    // burger and fries
      "1513104890138-7c749659a591"  // pizza
    ],
    Italian: [
      "1565299624946-b28f40a0ae38", // pizza
      "1473093295043-cdd812d0e601", // pasta
      "1551183053-bf91a1d81141"     // pasta dish
    ],
    Cafe: [
      "1525755662778-989d0524087e", // cafe table
      "1554118811-1e0d58224f24",    // cafe interior
      "1495474472287-4d71bcdd2085", // coffee
      "1482049016688-2d3e1b311543"  // breakfast toast
    ],
    Other: [
      "1414235077428-338989a2e8c0",
      "1546069901-ba9599a7e63c",
      "1567620905732-2d1ec7ab7445",
      "1540189549336-e6e99c3679fe",
      "1565958011703-44f9829ba187"
    ]
  };

  // Hand-picked matches where the restaurant's name or menu points to a specific look.
  const byId = {
    1003: "1467003909585-2f8a72700288", // The Lagoon - waterfront, fish
    1007: "1512058564366-18510be2db19", // Ofadaboy - ofada rice
    1008: "1569058242253-92a9c755a0ec", // SOHO - Chinese
    1012: "1519708227418-c8fd9a32b7a2", // Rapa Nui - seafood
    1014: "1537047902294-62a40c20a6ae", // Rhapsody's - lounge
    1024: "1552566626-52f8b828add9",    // Rhapsody's Abuja - modern interior
    1028: "1568901346375-23c9450c58cd"  // Bob's Diner - diner burger
  };

  const assigned = new Map();
  const counters = {};

  function poolFor(cuisine) {
    return pools[cuisine] || pools.Other;
  }

  // Give every listed restaurant its photo once, in list order, rotating through its pool.
  (window.forkscoreCountryRestaurants || []).forEach(r => {
    if (r.image) return;
    const key = pools[r.cuisine] ? r.cuisine : "Other";
    const pool = poolFor(key);
    counters[key] = counters[key] || 0;
    const photo = byId[r.id] || pool[counters[key] % pool.length];
    if (!byId[r.id]) counters[key] += 1;
    assigned.set(r.id, photo);
  });

  // Returns an image URL for a restaurant, or "" when it already has its own photo.
  window.forkscorePhotoFor = function (restaurant) {
    if (!restaurant || restaurant.image) return "";
    if (assigned.has(restaurant.id)) return U(assigned.get(restaurant.id));

    // Restaurants added by visitors: pick a stable photo from their id.
    const pool = poolFor(pools[restaurant.cuisine] ? restaurant.cuisine : "Other");
    const index = Math.abs(Number(restaurant.id) || 0) % pool.length;
    return U(pool[index]);
  };
})();
