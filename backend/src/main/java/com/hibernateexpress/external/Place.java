package com.hibernateexpress.external;

import com.hibernateexpress.geo.LatLng;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * A searchable place: a stop, station, campus, shop, village or a dropped pin. {@code category}
 * is a short human label such as "Bus station" or "Village" (empty when unknown).
 */
public record Place(String name, String detail, double lat, double lng, Kind kind, String category) {

  public Place {
    detail = detail == null ? "" : detail;
    category = category == null ? "" : category;
  }

  public Place(String name, String detail, double lat, double lng, Kind kind) {
    this(name, detail, lat, lng, kind, "");
  }

  public enum Kind {
    BUS("bus"),
    TRAIN("train"),
    AIRPORT("airport"),
    EDUCATION("education"),
    HOSPITAL("hospital"),
    WORSHIP("worship"),
    FOOD("food"),
    SHOP("shop"),
    FUEL("fuel"),
    PARK("park"),
    HOTEL("hotel"),
    CITY("city"),
    STREET("street"),
    POI("poi"),
    PIN("pin");

    private final String json;

    Kind(String json) {
      this.json = json;
    }

    public String json() {
      return json;
    }

    public static Kind fromJson(String value) {
      for (Kind k : values()) if (k.json.equals(value)) return k;
      return PIN;
    }

    @Override
    public String toString() {
      return json;
    }

    /** Classifies an OpenStreetMap tag (key=value) and Photon/Nominatim type. */
    public static Kind classify(String key, String value, String type) {
      String k = key == null ? "" : key;
      String v = value == null ? "" : value;
      String t = type == null ? "" : type;
      if (v.equals("bus_station") || v.equals("bus_stop") || (k.equals("public_transport") && v.equals("platform"))) {
        return BUS;
      }
      if (k.equals("railway") || v.equals("station") || v.equals("halt") || v.equals("train_station") || v.equals("subway")) {
        return TRAIN;
      }
      if (v.equals("aerodrome") || v.equals("airport") || v.equals("terminal")) return AIRPORT;
      if (v.equals("university") || v.equals("college") || v.equals("school") || v.equals("kindergarten")) return EDUCATION;
      if (v.equals("hospital") || v.equals("clinic") || v.equals("doctors") || v.equals("pharmacy") || k.equals("healthcare")) {
        return HOSPITAL;
      }
      if (v.equals("place_of_worship") || v.equals("temple") || v.equals("mosque") || v.equals("church")) return WORSHIP;
      if (v.equals("restaurant") || v.equals("fast_food") || v.equals("cafe") || v.equals("food_court") || v.equals("ice_cream")) {
        return FOOD;
      }
      if (v.equals("fuel")) return FUEL;
      if (k.equals("shop") || v.equals("marketplace") || v.equals("mall")) return SHOP;
      if (v.equals("park") || v.equals("garden") || v.equals("nature_reserve") || v.equals("playground")) return PARK;
      if (k.equals("tourism") && (v.equals("hotel") || v.equals("guest_house") || v.equals("hostel") || v.equals("motel"))) {
        return HOTEL;
      }
      if (k.equals("place")
          || k.equals("boundary")
          || t.equals("city")
          || t.equals("district")
          || t.equals("locality")
          || t.equals("county")
          || t.equals("state")
          || t.equals("town")
          || t.equals("village")) {
        return CITY;
      }
      if (t.equals("street") || k.equals("highway")) return STREET;
      return POI;
    }
  }

  /** A short label for an OpenStreetMap tag, like Google Maps shows under a result. */
  public static String label(String key, String value, String type) {
    String k = key == null ? "" : key;
    String v = value == null ? "" : value;
    String t = type == null ? "" : type;
    switch (v) {
      case "bus_stop":
        return "Bus stop";
      case "bus_station":
        return "Bus station";
      case "platform":
        return k.equals("public_transport") || k.equals("highway") ? "Bus stop" : "Platform";
      case "subway", "subway_entrance":
        return "Metro station";
      case "aerodrome", "airport":
        return "Airport";
      case "fuel":
        return "Petrol pump";
      case "atm":
        return "ATM";
      case "place_of_worship":
        return "Place of worship";
      case "fast_food":
        return "Fast food";
      case "marketplace":
        return "Market";
      case "townhall":
        return "Town hall";
      case "doctors":
        return "Clinic";
      case "yes":
        return k.equals("building") ? "Building" : capitalise(k);
      default:
        break;
    }
    if (k.equals("railway") && (v.equals("station") || v.equals("halt") || v.equals("stop"))) return "Railway station";
    if (k.equals("place")) {
      return switch (v) {
        case "city" -> "City";
        case "town" -> "Town";
        case "village" -> "Village";
        case "hamlet", "isolated_dwelling" -> "Hamlet";
        case "suburb", "quarter", "neighbourhood" -> "Area";
        case "locality" -> "Locality";
        case "state" -> "State";
        case "county", "district" -> "District";
        default -> capitalise(v);
      };
    }
    if (k.equals("boundary")) {
      return switch (t) {
        case "state" -> "State";
        case "county", "district" -> "District";
        case "city" -> "City";
        default -> "Area";
      };
    }
    if (k.equals("highway")) return "Road";
    if (k.equals("shop")) return v.isEmpty() ? "Shop" : capitalise(v) + " shop";
    if (!v.isEmpty()) return capitalise(v);
    return t.isEmpty() || t.equals("other") ? "" : capitalise(t);
  }

  private static String capitalise(String raw) {
    String s = raw.replace('_', ' ').trim();
    if (s.isEmpty()) return "";
    return s.substring(0, 1).toUpperCase(Locale.ROOT) + s.substring(1);
  }

  public LatLng position() {
    return new LatLng(lat, lng);
  }

  public Map<String, Object> toJson() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("name", name);
    m.put("detail", detail);
    m.put("lat", lat);
    m.put("lng", lng);
    m.put("kind", kind.json());
    if (!category.isEmpty()) m.put("category", category);
    return m;
  }
}
