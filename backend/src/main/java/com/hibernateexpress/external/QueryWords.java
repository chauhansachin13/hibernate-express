package com.hibernateexpress.external;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * How people actually type places in India, written out for the map data: "kazipet jn" means
 * Kazipet Junction, "rly stn" a railway station, "govt hosp" a government hospital, and
 * "hanamkonda busstand" a bus stand. OpenStreetMap names are spelled out, so Photon misses the
 * short forms ("kazipet jn" finds nothing at all) while the full words find the right place.
 */
final class QueryWords {

  private QueryWords() {}

  /** Short forms, as whole words, and what they stand for. */
  private static final Map<String, String> SHORT = Map.ofEntries(
      Map.entry("rly", "railway"),
      Map.entry("rlwy", "railway"),
      Map.entry("rlway", "railway"),
      Map.entry("stn", "station"),
      Map.entry("jn", "junction"),
      Map.entry("jnc", "junction"),
      Map.entry("jct", "junction"),
      Map.entry("jnct", "junction"),
      Map.entry("junc", "junction"),
      Map.entry("govt", "government"),
      Map.entry("hosp", "hospital"),
      Map.entry("clg", "college"),
      Map.entry("univ", "university"),
      Map.entry("rd", "road"),
      Map.entry("rds", "roads"),
      Map.entry("xrds", "x roads"),
      Map.entry("xroads", "x roads"),
      Map.entry("opp", "opposite"),
      Map.entry("nr", "near"),
      Map.entry("busstand", "bus stand"),
      Map.entry("bustand", "bus stand"),
      Map.entry("busstop", "bus stop"),
      Map.entry("busstation", "bus station"),
      Map.entry("busdepot", "bus depot"),
      Map.entry("railwaystation", "railway station"),
      Map.entry("hyd", "hyderabad"),
      Map.entry("secbad", "secunderabad"),
      Map.entry("blr", "bengaluru"),
      Map.entry("mgbs", "mahatma gandhi bus station"));

  /** The query with short forms written out, or null when there is nothing to write out. */
  static String expand(String query) {
    String[] words = query.trim().split("\\s+");
    List<String> out = new ArrayList<>(words.length);
    boolean changed = false;
    for (String word : words) {
      String bare = word.toLowerCase(Locale.ROOT).replaceAll("^[.,]+|[.,]+$", "");
      String full = SHORT.get(bare);
      if (full != null) {
        out.add(full);
        changed = true;
      } else {
        out.add(word);
      }
    }
    return changed ? String.join(" ", out) : null;
  }
}
