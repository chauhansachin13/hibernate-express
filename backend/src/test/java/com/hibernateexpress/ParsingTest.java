package com.hibernateexpress;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.hibernateexpress.json.Json;
import com.hibernateexpress.parse.CoordinateParser;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

/** Coordinate parsing and the JSON library. */
class ParsingTest {

  @ParameterizedTest(name = "{0}")
  @CsvSource(
      delimiter = '|',
      value = {
        "17.9833, 79.5308 | 17.9833 | 79.5308",
        "17.9833 79.5308 | 17.9833 | 79.5308",
        "-33.8688,151.2093 | -33.8688 | 151.2093",
        "17°58'59.9\"N 79°31'50.9\"E | 17.98331 | 79.53081",
        "17.98 N, 79.53 E | 17.98 | 79.53",
        "N 17.98 E 79.53 | 17.98 | 79.53",
        "79.53 E 17.98 N | 17.98 | 79.53",
        "33°52′S 151°12′E | -33.86667 | 151.2",
        "https://www.google.com/maps/@17.9833,79.5308,15z | 17.9833 | 79.5308",
        "https://www.google.com/maps/place/NIT/@17.98,79.53,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d17.9837!4d79.5307 | 17.9837 | 79.5307",
        "https://maps.google.com/?q=17.9833,79.5308 | 17.9833 | 79.5308",
        "https://www.google.com/maps/search/?api=1&query=17.9833%2C79.5308 | 17.9833 | 79.5308",
        "https://www.openstreetmap.org/#map=16/17.9833/79.5308 | 17.9833 | 79.5308",
        "geo:17.9833,79.5308?z=15 | 17.9833 | 79.5308"
      })
  void readsCoordinates(String input, double lat, double lng) {
    CoordinateParser.Ok ok = assertInstanceOf(CoordinateParser.Ok.class, CoordinateParser.parse(input));
    assertEquals(lat, ok.value().lat(), 5e-5);
    assertEquals(lng, ok.value().lng(), 5e-5);
  }

  @ParameterizedTest(name = "rejects \"{0}\"")
  @ValueSource(strings = {"", "hello", "95, 10", "10, 200", "17.9 N 79.5 N", "https://maps.app.goo.gl/abc123"})
  void rejectsWithAHelpfulMessage(String input) {
    CoordinateParser.Err err = assertInstanceOf(CoordinateParser.Err.class, CoordinateParser.parse(input));
    assertTrue(err.error().length() > 10);
  }

  @Test
  void jsonRoundTripsNestedValues() {
    Map<String, Object> in = new LinkedHashMap<>();
    in.put("name", "NIT \"Warangal\"\n✓ ಕನ್ನಡ");
    in.put("lat", 17.9837);
    in.put("count", 3);
    in.put("ok", true);
    in.put("none", null);
    in.put("nan", Double.NaN);
    in.put("list", List.of(1.5, "two", Map.of("x", -0.25)));
    String text = Json.stringify(in);
    Map<String, Object> out = Json.object(Json.parse(text));
    assertEquals("NIT \"Warangal\"\n✓ ಕನ್ನಡ", out.get("name"));
    assertEquals(17.9837, (Double) out.get("lat"));
    assertEquals(3.0, (Double) out.get("count"));
    assertEquals(true, out.get("ok"));
    assertTrue(out.containsKey("none") && out.get("none") == null);
    assertTrue(out.get("nan") == null, "NaN is written as null");
    assertEquals(List.of(1.5, "two", Map.of("x", -0.25)), out.get("list"));
  }

  @Test
  void jsonParsesEscapesNumbersAndWhitespace() {
    Object v = Json.parse(" { \"a\" : [ 1e3, -2.5E-2, 0 ], \"s\": \"\\u0041\\t\\/\" } ");
    Map<String, Object> m = Json.object(v);
    assertEquals(Arrays.asList(1000.0, -0.025, 0.0), m.get("a"));
    assertEquals("A\t/", m.get("s"));
    assertEquals("[1,2.5,null]", Json.stringify(new double[] {1, 2.5, Double.POSITIVE_INFINITY}));
  }

  @ParameterizedTest
  @ValueSource(strings = {"{", "[1,]", "{\"a\" 1}", "tru", "\"unterminated", "{} x", "[1 2]"})
  void jsonRejectsMalformedInput(String input) {
    assertThrows(Json.ParseException.class, () -> Json.parse(input));
  }
}
