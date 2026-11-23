package com.hibernateexpress.external;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * "Near me" searches, like Google Maps answers "bus stand" or "hospital near Kazipet" with the
 * closest ones rather than places that happen to have the words in their name.
 *
 * @param radiusKm how far to look
 * @param tags OpenStreetMap tags to look for, as {@code key:value} (any of them)
 * @param names when not null, a name must match it (OpenStreetMap search can't filter by
 *     religion, so "temple" keeps the places of worship whose name says temple)
 */
public record NearbyCategory(String label, Place.Kind kind, int radiusKm, List<String> tags, Pattern names) {

  /**
   * A category, plus the place it should be near ("" = near you). {@code placeFirst}: written the
   * Indian way, place first ("kazipet railway station"), where those words might also just be a
   * name ("Mahatma Gandhi Bus Station"), so the search checks they name a town or an area.
   */
  public record Match(NearbyCategory category, String near, boolean placeFirst) {
    public Match(NearbyCategory category, String near) {
      this(category, near, false);
    }
  }

  /** Transit stops people write after the place: "kazipet railway station", "hanamkonda bus stand". */
  private static final List<String> PLACE_FIRST =
      List.of("railway station", "train station", "rly station", "railway stn", "bus stand", "bus station", "bus depot", "metro station");

  private static final Map<String, NearbyCategory> PHRASES = new LinkedHashMap<>();
  /** Longest phrases first, so "bus stop" wins over "bus". */
  private static final List<String> BY_LENGTH;

  private static final Pattern NON_WORD = Pattern.compile("[^\\p{L}\\p{M}\\p{N}]+");
  private static final Pattern LEADING = Pattern.compile("^(?:nearest|closest|nearby|near by|find|show)\\s+");
  private static final Pattern TRAILING =
      Pattern.compile("\\s+(?:near me|nearby|near by|around me|close to me|closest to me|in my area|near here|here)$");
  private static final Pattern CONNECTOR = Pattern.compile("^(?:in|near|at|around|close to|nearby|near to)\\s+(.+)$");

  static {
    add("Bus stop", Place.Kind.BUS, 3, null, List.of("bus stop", "bus stopage", "bus shelter", "bus halt"),
        "highway:bus_stop", "amenity:bus_station");
    add("Bus station", Place.Kind.BUS, 30, null,
        List.of("bus stand", "bus station", "bus depot", "bus terminal", "bus", "rtc bus stand", "rtc", "tsrtc", "tgsrtc", "apsrtc",
            "ksrtc", "msrtc", "upsrtc", "gsrtc"),
        "amenity:bus_station");
    add("Railway station", Place.Kind.TRAIN, 50, null,
        List.of("railway station", "train station", "railway", "station", "train", "rly station", "railway stn"),
        "railway:station", "railway:halt");
    add("Metro station", Place.Kind.TRAIN, 25, "metro|mmts|subway", List.of("metro", "metro station", "subway", "mmts"),
        "railway:station", "railway:halt", "building:train_station");
    add("Airport", Place.Kind.AIRPORT, 300, "airport|international", List.of("airport", "aerodrome", "flight", "flights"),
        "aeroway:aerodrome");
    add("Hospital", Place.Kind.HOSPITAL, 20, null, List.of("hospital", "emergency", "casualty"), "amenity:hospital");
    add("Clinic", Place.Kind.HOSPITAL, 8, null, List.of("clinic", "doctor", "doctors"), "amenity:clinic", "amenity:doctors");
    add("Pharmacy", Place.Kind.HOSPITAL, 5, null,
        List.of("pharmacy", "medical", "medical shop", "medical store", "chemist", "medicine", "medicines"),
        "amenity:pharmacy", "shop:chemist");
    add("ATM", Place.Kind.POI, 5, null, List.of("atm", "atm machine", "cash"), "amenity:atm", "amenity:bank");
    add("Bank", Place.Kind.POI, 8, null, List.of("bank"), "amenity:bank");
    add("Petrol pump", Place.Kind.FUEL, 15, null,
        List.of("petrol pump", "petrol bunk", "petrol", "diesel", "fuel", "gas station", "petrol station", "cng", "filling station"),
        "amenity:fuel");
    add("Temple", Place.Kind.WORSHIP, 10,
        "temple|mandir|gudi|devalay|alayam|swamy|swami|devi|amma|matha|math|balaji|hanuman|anjaneya|shiva|siva|ganesh|ganapati|sai|krishna|rama|venkate|lakshmi|durga|kali",
        List.of("temple", "mandir", "gudi", "devalayam"), "amenity:place_of_worship");
    add("Mosque", Place.Kind.WORSHIP, 10, "masjid|mosque|dargah|eidgah|idgah|jama|jamia", List.of("mosque", "masjid", "dargah"),
        "amenity:place_of_worship");
    add("Church", Place.Kind.WORSHIP, 15, "church|chapel|cathedral|basilica|ministr|prayer|parish|csi|baptist",
        List.of("church"), "amenity:place_of_worship");
    add("Gurudwara", Place.Kind.WORSHIP, 40, "gurd?u?wara|gurudwara|gurdwara|sikh", List.of("gurudwara", "gurdwara"),
        "amenity:place_of_worship");
    add("Restaurant", Place.Kind.FOOD, 4, null, List.of("restaurant", "food", "dhaba", "mess", "tiffin", "tiffins", "eat"),
        "amenity:restaurant", "amenity:fast_food", "amenity:food_court");
    add("Cafe", Place.Kind.FOOD, 4, null, List.of("cafe", "coffee", "tea", "tea stall", "chai", "bakery"), "amenity:cafe", "shop:bakery");
    add("Hotel", Place.Kind.HOTEL, 15, null, List.of("hotel", "lodge", "guest house", "hostel", "stay", "rooms"),
        "tourism:hotel", "tourism:guest_house", "tourism:hostel", "tourism:motel");
    add("School", Place.Kind.EDUCATION, 6, null, List.of("school"), "amenity:school");
    add("College", Place.Kind.EDUCATION, 20, null, List.of("college", "engineering college", "degree college", "junior college"),
        "amenity:college");
    add("University", Place.Kind.EDUCATION, 50, null, List.of("university", "campus"), "amenity:university");
    add("Police station", Place.Kind.POI, 15, null, List.of("police", "police station", "thana"), "amenity:police");
    add("Post office", Place.Kind.POI, 15, null, List.of("post office", "post", "india post"), "amenity:post_office");
    add("Park", Place.Kind.PARK, 10, null, List.of("park", "garden"), "leisure:park");
    add("Mall", Place.Kind.SHOP, 25, null, List.of("mall", "shopping mall", "shopping"), "shop:mall");
    add("Market", Place.Kind.SHOP, 15, null, List.of("market", "bazaar", "bazar", "mandi", "rythu bazar", "vegetable market"),
        "amenity:marketplace");
    add("Supermarket", Place.Kind.SHOP, 6, null, List.of("supermarket", "grocery", "kirana", "groceries"),
        "shop:supermarket", "shop:convenience");
    add("Toilets", Place.Kind.POI, 5, null, List.of("toilet", "washroom", "restroom", "public toilet"), "amenity:toilets");
    add("Parking", Place.Kind.POI, 4, null, List.of("parking", "car parking", "bike parking"), "amenity:parking");
    add("Taxi stand", Place.Kind.POI, 8, null, List.of("taxi", "taxi stand", "auto stand", "auto"), "amenity:taxi");
    add("Cinema", Place.Kind.POI, 20, null, List.of("cinema", "theatre", "theater", "movie theatre", "multiplex", "movies"),
        "amenity:cinema");
    List<String> phrases = new ArrayList<>(PHRASES.keySet());
    phrases.sort(Comparator.comparingInt(String::length).reversed());
    BY_LENGTH = List.copyOf(phrases);
  }

  private static void add(String label, Place.Kind kind, int radiusKm, String names, List<String> phrases, String... tags) {
    Pattern filter = names == null ? null : Pattern.compile("(?i)\\b(?:" + names + ")");
    NearbyCategory c = new NearbyCategory(label, kind, radiusKm, List.of(tags), filter);
    for (String p : phrases) {
      PHRASES.putIfAbsent(p, c);
      PHRASES.putIfAbsent(p + "s", c);
      PHRASES.putIfAbsent(p + "es", c);
    }
  }

  /** Whether a place found by tag fits this category (always, unless the name must say so). */
  public boolean accepts(Place place) {
    return names == null || names.matcher(place.name()).find();
  }

  /** Lower case, punctuation as spaces, single spaces. */
  static String normalize(String text) {
    return NON_WORD.matcher(text.toLowerCase(Locale.ROOT)).replaceAll(" ").trim();
  }

  /**
   * "bus stand", "hospitals near me", "nearest atm" → near you; "atm in ameerpet", "hospital near
   * kazipet" → near that place. Anything else (including names like "Apollo Hospital") → null.
   */
  public static Match match(String query) {
    String q = normalize(query);
    q = LEADING.matcher(q).replaceFirst("");
    q = TRAILING.matcher(q).replaceFirst("");
    NearbyCategory exact = PHRASES.get(q);
    if (exact != null) return new Match(exact, "");
    for (String phrase : BY_LENGTH) {
      if (!q.startsWith(phrase + " ")) continue;
      var m = CONNECTOR.matcher(q.substring(phrase.length() + 1));
      if (m.matches() && !m.group(1).isBlank()) return new Match(PHRASES.get(phrase), m.group(1).trim());
    }
    for (String phrase : PLACE_FIRST) {
      NearbyCategory category = PHRASES.get(phrase);
      if (category == null || !q.endsWith(" " + phrase)) continue;
      String place = q.substring(0, q.length() - phrase.length() - 1).trim();
      if (!place.isEmpty()) return new Match(category, place, true);
    }
    return null;
  }
}
