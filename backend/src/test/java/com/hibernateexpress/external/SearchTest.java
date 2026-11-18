package com.hibernateexpress.external;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.json.Json;
import com.hibernateexpress.parse.CoordinateParser;
import com.hibernateexpress.parse.PlusCode;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

/** Search like Google Maps: names, "near me", coordinates, plus codes and map links. */
class SearchTest {

  static final LatLng WARANGAL = new LatLng(17.9837, 79.5307);
  static final LatLng AMEERPET = new LatLng(17.4375, 78.4482);

  // ------------------------------------------------------------------ plus codes

  @Test
  void decodesTheReferenceExample() {
    LatLng p = PlusCode.decode("8FVC9G8F+6X");
    assertEquals(47.3655625, p.lat(), 1e-7);
    assertEquals(8.5249375, p.lng(), 1e-7);
  }

  @Test
  void encodesAndDecodesWithinAFewMetres() {
    assertEquals("7J9XXGMJ+F7", PlusCode.encode(WARANGAL.lat(), WARANGAL.lng()));
    for (LatLng p : List.of(WARANGAL, AMEERPET, new LatLng(-33.8688, 151.2093), new LatLng(51.5007, -0.1246), new LatLng(0.0001, -179.9999))) {
      String code = PlusCode.encode(p.lat(), p.lng());
      assertTrue(PlusCode.isFull(code), code);
      assertTrue(Geo.haversine(p, PlusCode.decode(code)) < 10, code);
    }
  }

  @Test
  void recoversShortCodesFromANearbyReference() {
    LatLng p = PlusCode.recover("9G8F+6X", new LatLng(47.4, 8.6));
    assertEquals(47.3655625, p.lat(), 1e-7);
    assertEquals(8.5249375, p.lng(), 1e-7);
    // The reference sits in the next 1° cell; the nearest match is still found.
    assertEquals(47.3655625, PlusCode.recover("9G8F+6X", new LatLng(46.99, 8.6)).lat(), 1e-7);
    assertTrue(Geo.haversine(PlusCode.recover("XGMJ+F7", new LatLng(18.0, 79.58)), WARANGAL) < 10);
  }

  @ParameterizedTest
  @ValueSource(strings = {"C++", "AB+CD", "8FVC9G8F+6", "8F0C9G8F+", "8FVC9G8F+6X+", "8FVC9G8F6X"})
  void rejectsThingsThatAreNotPlusCodes(String text) {
    assertFalse(PlusCode.isValid(text));
  }

  @Test
  void findsAPlusCodeInText() {
    PlusCode.Found f = PlusCode.find("XGMJ+F7 Warangal, Telangana");
    assertEquals("XGMJ+F7", f.code());
    assertEquals("Warangal, Telangana", f.locality());
    assertEquals("", PlusCode.find("7j9xxgmj+f7").locality());
    assertNull(PlusCode.find("Hanamkonda bus stand"));
  }

  // ------------------------------------------------------------------- near me

  @ParameterizedTest
  @CsvSource({
    "bus stand, Bus station, ''",
    "Bus stops near me, Bus stop, ''",
    "nearest ATM, ATM, ''",
    "petrol bunk, Petrol pump, ''",
    "temples, Temple, ''",
    "metro, Metro station, ''",
    "atm in Ameerpet, ATM, ameerpet",
    "hospital near Kazipet, Hospital, kazipet",
  })
  void understandsNearMeSearches(String query, String label, String near) {
    NearbyCategory.Match m = NearbyCategory.match(query);
    assertNotNull(m, query);
    assertEquals(label, m.category().label());
    assertEquals(near, m.near());
  }

  @ParameterizedTest
  @ValueSource(strings = {"Apollo Hospital", "station road", "Hanamkonda bus stand", "NIT Warangal", "kazipet"})
  void leavesPlaceNamesToTheTextSearch(String query) {
    assertNull(NearbyCategory.match(query));
  }

  @Test
  void findsTheNearestPlacesOfAKind() {
    List<String> urls = new ArrayList<>();
    String body =
        "{\"features\":["
            + featureAt("Far Bus Station", "bus_station", 18.0000, 79.5307) + ","
            + featureAt("Near Bus Station", "bus_station", 17.9850, 79.5307) + ","
            + featureAt("near bus station", "bus_station", 17.9851, 79.5308) + ","
            + featureAt("Middle Bus Station", "bus_station", 17.9900, 79.5307) + "]}";
    HttpFetcher http = (url, timeout) -> {
      urls.add(url);
      return CompletableFuture.completedFuture(new HttpFetcher.Response(200, body));
    };
    GeocodingClient photon = new GeocodingClient(http, () -> 0L);
    List<Place> places = photon.find(NearbyCategory.match("bus stand").category(), WARANGAL).join();
    assertEquals(List.of("Near Bus Station", "Middle Bus Station", "Far Bus Station"), names(places));
    assertEquals("Bus station", places.get(0).category());
    assertEquals(Place.Kind.BUS, places.get(0).kind());
    assertTrue(urls.get(0).startsWith("https://photon.komoot.io/reverse?lat=17.98370&lon=79.53070&radius=30&limit=25&lang=en"), urls.get(0));
    assertTrue(urls.get(0).endsWith("&osm_tag=amenity%3Abus_station"), urls.get(0));
    // The next keystroke ("bus stands") is answered from the cache.
    photon.find(NearbyCategory.match("bus stands").category(), WARANGAL).join();
    assertEquals(1, urls.size());
  }

  @Test
  void keepsOnlyTemplesForTemplesAndMosquesForMosques() {
    String body =
        "{\"features\":["
            + featureAt("St. Paul's Church", "place_of_worship", 17.985, 79.53) + ","
            + featureAt("Sri Venkateswara Swamy Temple", "place_of_worship", 17.99, 79.53) + ","
            + featureAt("Masjid E Kalan", "place_of_worship", 17.98, 79.53) + "]}";
    GeocodingClient photon = new GeocodingClient((u, t) -> CompletableFuture.completedFuture(new HttpFetcher.Response(200, body)), () -> 0L);
    List<Place> temples = photon.find(NearbyCategory.match("temple").category(), WARANGAL).join();
    assertEquals(List.of("Sri Venkateswara Swamy Temple"), names(temples));
    assertEquals("Temple", temples.get(0).category());
    assertEquals(List.of("Masjid E Kalan"), names(photon.find(NearbyCategory.match("masjid").category(), WARANGAL).join()));
    assertEquals(List.of("St. Paul's Church"), names(photon.find(NearbyCategory.match("church").category(), WARANGAL).join()));
  }

  // -------------------------------------------------------------- Photon mapping

  @Test
  void dropsServiceRoadsAndLandUseWhenRealPlacesWereFound() {
    StringBuilder features = new StringBuilder();
    for (int i = 0; i < 7; i++) features.append(feature("Stop " + i, "highway", "bus_stop", "house")).append(',');
    features.append(feature("Depot Inner Road", "highway", "service", "street")).append(',');
    features.append(feature("Depot", "landuse", "industrial", "other"));
    List<Place> places = GeocodingClient.fromPhoton(Json.object(Json.parse("{\"features\":[" + features + "]}")), null, true);
    assertEquals(7, places.size());
    assertEquals("Bus stop", places.get(0).category());
    assertEquals("Warangal, Telangana", places.get(0).detail());
    // With few results the minor ones stay, at the end.
    String few = "{\"features\":[" + feature("B Inner Road", "highway", "service", "street") + "," + feature("A", "amenity", "school", "house") + "]}";
    assertEquals(List.of("A", "B Inner Road"), names(GeocodingClient.fromPhoton(Json.object(Json.parse(few)), null, true)));
  }

  @Test
  void labelsPlacesLikeAMapApp() {
    assertEquals("Railway station", Place.label("railway", "station", "house"));
    assertEquals("Village", Place.label("place", "village", "city"));
    assertEquals("Road", Place.label("highway", "residential", "street"));
    assertEquals("Clothes shop", Place.label("shop", "clothes", "house"));
    assertEquals("Petrol pump", Place.label("amenity", "fuel", "house"));
    assertEquals(Place.Kind.HOSPITAL, Place.Kind.classify("amenity", "hospital", "house"));
    assertEquals(Place.Kind.WORSHIP, Place.Kind.classify("amenity", "place_of_worship", "house"));
    assertEquals(Place.Kind.BUS, Place.Kind.classify("highway", "bus_stop", "house"));
  }

  // ------------------------------------------------------------------- ranking

  @Test
  void ranksExactAndPrefixMatchesFirst() {
    List<Place> photon =
        List.of(
            place("Old Kazipet Road", 17.99, 79.53, "Road"),
            place("Kazipet Junction", 17.975, 79.53, "Railway station"),
            place("Kazipet", 17.98, 79.53, "Town"),
            place("LIC Office Kazipet", 17.976, 79.53, "Office"));
    assertEquals(
        List.of("Kazipet", "Kazipet Junction", "Old Kazipet Road", "LIC Office Kazipet"),
        names(PlaceSearch.merge(List.of(), photon, List.of(), "kazipet", WARANGAL)));
  }

  @Test
  void putsNearbyResultsFirstAndMergesSourcesWithoutDuplicates() {
    List<Place> near = List.of(place("Hanamkonda Bus Station", 17.99, 79.55, "Bus station"));
    List<Place> photon = List.of(place("Hanamkonda Bus Station", 17.9901, 79.5501, "Bus station"), place("Bus Stand Road", 17.9, 79.5, "Road"));
    List<Place> nominatim = List.of(place("Bus Stand Road", 17.9001, 79.5, "Road"), place("Jammikunta Bus Stand", 18.29, 79.47, "Bus station"));
    List<Place> merged = PlaceSearch.merge(near, photon, nominatim, "bus stand", WARANGAL);
    assertEquals(List.of("Hanamkonda Bus Station", "Bus Stand Road", "Jammikunta Bus Stand"), names(merged));
  }

  @Test
  void forgivesTyposAndPrefersTownsLikeGoogleDoes() {
    List<Place> photon =
        List.of(
            new Place("Hyderbad Metro Rail Parking", "Telangana", 17.37, 78.53, Place.Kind.POI, "Parking"),
            new Place("Hyderbad Biryani House", "Victoria Road", -33.8, 151.0, Place.Kind.FOOD, "Restaurant"),
            new Place("Hyderabad", "Telangana, India", 17.36, 78.47, Place.Kind.CITY, "City"));
    assertEquals("Hyderabad", PlaceSearch.merge(List.of(), photon, List.of(), "hyderbad", WARANGAL).get(0).name());
    // "hanamkonda bus" finds the station spelt "Hanumakonda".
    List<Place> station =
        List.of(
            new Place("Old Bus Depo", "Hanamkonda", 17.995, 79.56, Place.Kind.POI, "Childcare"),
            new Place("TGSRTC Bus Station , Hanumakonda", "Nakkala Gutta", 18.003, 79.56, Place.Kind.BUS, "Bus station"));
    assertEquals("TGSRTC Bus Station , Hanumakonda", PlaceSearch.merge(List.of(), station, List.of(), "hanamkonda bus", WARANGAL).get(0).name());
    assertTrue(PlaceSearch.similar("hyderbad", "hyderabad"));
    assertTrue(PlaceSearch.similar("hanamkonda", "hanumakonda"));
    assertFalse(PlaceSearch.similar("bus", "bun"), "short words must match exactly");
    assertFalse(PlaceSearch.similar("kazipet", "warangal"));
  }

  @Test
  void pushesOtherCountriesDown() {
    List<Place> photon =
        List.of(
            new Place("Charminar", "Adelaide", -34.98, 138.6, Place.Kind.FOOD, "Restaurant"),
            new Place("Charminar", "Praia da Rocha", 37.12, -8.53, Place.Kind.FOOD, "Restaurant"),
            new Place("Charminar", "Hyderabad", 17.3616, 78.4747, Place.Kind.POI, "Attraction"));
    assertEquals("Hyderabad", PlaceSearch.merge(List.of(), photon, List.of(), "charminar", WARANGAL).get(0).detail());
  }

  @Test
  void capsTheList() {
    List<Place> many = new ArrayList<>();
    for (int i = 0; i < 30; i++) many.add(place("Place " + i, 10 + i * 0.1, 79, "Shop"));
    assertEquals(PlaceSearch.LIMIT, PlaceSearch.merge(List.of(), many, List.of(), "place", WARANGAL).size());
  }

  // --------------------------------------------------------------- whole search

  @Test
  void searchesTextNearbyAndThoroughSourcesTogether() {
    FakeGeocoder geo = new FakeGeocoder();
    PlaceSearch search =
        new PlaceSearch(geo, (c, p) -> done(place("Closest " + c.label(), p.lat() + 0.001, p.lng(), c.label())), LinkResolver.NONE);

    PlaceSearch.Result typeAhead = search.search("bus stand", WARANGAL, 13, false).join();
    assertEquals(List.of("Closest Bus station", "bus stand (photon)"), names(typeAhead.places()));
    assertTrue(typeAhead.more());
    assertTrue(geo.thorough.isEmpty(), "Nominatim is only asked when the user wants more");

    PlaceSearch.Result explicit = search.search("bus stand", WARANGAL, 13, true).join();
    assertFalse(explicit.more());
    assertTrue(names(explicit.places()).contains("bus stand (nominatim)"));

    // "atm in ameerpet" looks around Ameerpet, not around you.
    Place atm = search.search("atm in ameerpet", WARANGAL, 13, false).join().places().get(0);
    assertEquals("Closest ATM", atm.name());
    assertEquals(AMEERPET.lat() + 0.001, atm.lat(), 1e-9);
  }

  @Test
  void readsCoordinatesPlusCodesAndLinks() {
    FakeGeocoder geo = new FakeGeocoder();
    LinkResolver links =
        url -> url.contains("pin")
            ? CompletableFuture.completedFuture("https://www.google.com/maps/search/17.983745,+79.530652?entry=tts")
            : url.contains("place")
                ? CompletableFuture.completedFuture("https://www.google.com/maps/place/Charminar/data=!4m2!3m1!1s0x0:0x0")
                : CompletableFuture.failedFuture(new IllegalStateException("offline"));
    PlaceSearch search = new PlaceSearch(geo, NearbyFinder.NONE, links);

    Place coords = first(search, "17.9837, 79.5307");
    assertEquals(Place.Kind.PIN, coords.kind());
    assertEquals(17.9837, coords.lat(), 1e-9);

    Place full = first(search, "7J9XXGMJ+F7");
    assertTrue(Geo.haversine(full.position(), WARANGAL) < 10);
    assertEquals("Plus code", full.category());

    Place recovered = first(search, "XGMJ+F7 Warangal");
    assertTrue(Geo.haversine(recovered.position(), WARANGAL) < 10);
    assertTrue(geo.searches.contains("Warangal"));

    PlaceSearch.Result noTown = search.search("XGMJ+F7", null, 12, false).join();
    assertTrue(noTown.places().isEmpty());
    assertNotNull(noTown.message());

    Place shared = first(search, "Look at this https://maps.app.goo.gl/pin123");
    assertEquals(17.983745, shared.lat(), 1e-9);
    assertEquals(79.530652, shared.lng(), 1e-9);

    assertEquals("Charminar", first(search, "https://maps.app.goo.gl/place456").name());

    PlaceSearch.Result broken = search.search("https://maps.app.goo.gl/broken", null, 12, false).join();
    assertTrue(broken.places().isEmpty());
    assertNotNull(broken.message());

    assertEquals(17.9833, first(search, "https://www.google.com/maps/@17.9833,79.5308,15z").lat(), 1e-9);
  }

  @Test
  void failsOnlyWhenNothingCouldBeSearched() {
    FakeGeocoder geo = new FakeGeocoder();
    geo.failText = true;
    PlaceSearch search = new PlaceSearch(geo, NearbyFinder.NONE, LinkResolver.NONE);
    assertThrows(CompletionException.class, () -> search.search("kazipet", WARANGAL, 12, false).join());
    // Asking for more still reaches Nominatim.
    assertEquals("kazipet (nominatim)", search.search("kazipet", WARANGAL, 12, true).join().places().get(0).name());
  }

  @Test
  void expandsShortLinksForThePasteBox() {
    PlaceSearch search =
        new PlaceSearch(new FakeGeocoder(), NearbyFinder.NONE, url -> CompletableFuture.completedFuture("https://www.google.com/maps/search/17.98,+79.53"));
    assertInstanceOf(CoordinateParser.Ok.class, search.coordinates("https://maps.app.goo.gl/abc").join());
    assertInstanceOf(CoordinateParser.Ok.class, search.coordinates("17.98, 79.53").join());
    PlaceSearch offline = new PlaceSearch(new FakeGeocoder(), NearbyFinder.NONE, LinkResolver.NONE);
    assertInstanceOf(CoordinateParser.Err.class, offline.coordinates("https://maps.app.goo.gl/abc").join());
  }

  @Test
  void onlyFollowsGoogleLinksOverHttps() {
    assertTrue(LinkResolver.Jdk.allowed(URI.create("https://maps.app.goo.gl/abc")));
    assertTrue(LinkResolver.Jdk.allowed(URI.create("https://www.google.com/maps/place/x")));
    assertTrue(LinkResolver.Jdk.allowed(URI.create("https://maps.google.co.in/?q=1,2")));
    assertFalse(LinkResolver.Jdk.allowed(URI.create("http://maps.app.goo.gl/abc")));
    assertFalse(LinkResolver.Jdk.allowed(URI.create("https://evil.example/google.com")));
    assertFalse(LinkResolver.Jdk.allowed(URI.create("https://google.com.evil.example/")));
    assertFalse(LinkResolver.Jdk.allowed(URI.create("https://127.0.0.1/")));
    assertTrue(LinkResolver.isShortLink("https://maps.app.goo.gl/AbC123"));
    assertFalse(LinkResolver.isShortLink("https://www.google.com/maps/@1,2,3z"));
  }

  // ------------------------------------------------------------------- helpers

  static final class FakeGeocoder implements Geocoder {
    final List<String> searches = new ArrayList<>();
    final List<String> thorough = new ArrayList<>();
    boolean failText;

    @Override
    public synchronized CompletableFuture<List<Place>> search(String query, LatLng bias, int zoom) {
      searches.add(query);
      if (failText) return CompletableFuture.failedFuture(new IllegalStateException("Photon is down"));
      return switch (query) {
        case "ameerpet" -> done(place("Ameerpet", AMEERPET.lat(), AMEERPET.lng(), "Area"));
        case "Warangal" -> done(place("Warangal", 17.9689, 79.5941, "City"));
        case "Charminar" -> done(place("Charminar", 17.3616, 78.4747, "Monument"));
        default -> done(place(query + " (photon)", 17.99, 79.53, "Place"));
      };
    }

    @Override
    public synchronized CompletableFuture<List<Place>> searchFallback(String query) {
      thorough.add(query);
      return done(place(query + " (nominatim)", 17.5, 79.0, "Place"));
    }

    @Override
    public CompletableFuture<Place> reverse(LatLng at) {
      return CompletableFuture.completedFuture(null);
    }
  }

  private static Place first(PlaceSearch search, String query) {
    return search.search(query, null, 12, false).join().places().get(0);
  }

  static Place place(String name, double lat, double lng, String category) {
    return new Place(name, "Telangana", lat, lng, Place.Kind.POI, category);
  }

  static CompletableFuture<List<Place>> done(Place... places) {
    return CompletableFuture.completedFuture(List.of(places));
  }

  static List<String> names(List<Place> places) {
    return places.stream().map(Place::name).toList();
  }

  private static String featureAt(String name, String amenity, double lat, double lng) {
    return """
        {"geometry":{"coordinates":[%s,%s]},"properties":{"name":"%s","osm_key":"amenity","osm_value":"%s","type":"house","city":"Hanamkonda"}}"""
        .formatted(lng, lat, name, amenity);
  }

  private static String feature(String name, String key, String value, String type) {
    return """
        {"geometry":{"coordinates":[79.53,17.98]},"properties":{"name":"%s","osm_key":"%s","osm_value":"%s","type":"%s","city":"Warangal","state":"Telangana"}}"""
        .formatted(name, key, value, type);
  }
}
