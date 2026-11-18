package com.hibernateexpress.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON reader and writer. Objects parse to {@code LinkedHashMap<String, Object>},
 * arrays to {@code ArrayList<Object>}, numbers to {@code Double}. Writing accepts maps,
 * iterables, arrays of doubles, strings, numbers, booleans, enums and null; non-finite numbers
 * are written as null.
 */
public final class Json {

  private Json() {}

  public static Object parse(String text) {
    Parser p = new Parser(text);
    p.skipWhitespace();
    Object value = p.value();
    p.skipWhitespace();
    if (!p.atEnd()) throw p.error("Unexpected characters after the JSON value");
    return value;
  }

  public static String stringify(Object value) {
    StringBuilder sb = new StringBuilder();
    write(sb, value);
    return sb.toString();
  }

  // ------------------------------------------------------------------ typed access helpers

  @SuppressWarnings("unchecked")
  public static Map<String, Object> object(Object value) {
    return value instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
  }

  public static List<?> list(Map<String, Object> obj, String key) {
    return obj.get(key) instanceof List<?> l ? l : List.of();
  }

  public static double number(Map<String, Object> obj, String key, double fallback) {
    Object v = obj.get(key);
    if (v instanceof Number n) return n.doubleValue();
    if (v instanceof String s) {
      try {
        return Double.parseDouble(s.trim());
      } catch (NumberFormatException e) {
        return fallback;
      }
    }
    return fallback;
  }

  public static String string(Map<String, Object> obj, String key, String fallback) {
    return obj.get(key) instanceof String s ? s : fallback;
  }

  public static boolean bool(Map<String, Object> obj, String key, boolean fallback) {
    return obj.get(key) instanceof Boolean b ? b : fallback;
  }

  // ------------------------------------------------------------------------------ writer

  private static void write(StringBuilder sb, Object v) {
    if (v == null) {
      sb.append("null");
    } else if (v instanceof String s) {
      quote(sb, s);
    } else if (v instanceof Boolean b) {
      sb.append(b.booleanValue());
    } else if (v instanceof Double || v instanceof Float) {
      double d = ((Number) v).doubleValue();
      if (!Double.isFinite(d)) sb.append("null");
      else if (d == Math.rint(d) && Math.abs(d) < 1e15) sb.append((long) d);
      else sb.append(d);
    } else if (v instanceof Number n) {
      sb.append(n);
    } else if (v instanceof Map<?, ?> m) {
      sb.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : m.entrySet()) {
        if (!first) sb.append(',');
        first = false;
        quote(sb, String.valueOf(e.getKey()));
        sb.append(':');
        write(sb, e.getValue());
      }
      sb.append('}');
    } else if (v instanceof Iterable<?> it) {
      sb.append('[');
      boolean first = true;
      for (Object o : it) {
        if (!first) sb.append(',');
        first = false;
        write(sb, o);
      }
      sb.append(']');
    } else if (v instanceof double[] arr) {
      sb.append('[');
      for (int i = 0; i < arr.length; i++) {
        if (i > 0) sb.append(',');
        write(sb, arr[i]);
      }
      sb.append(']');
    } else if (v instanceof Enum<?> e) {
      quote(sb, e.toString());
    } else {
      quote(sb, v.toString());
    }
  }

  private static void quote(StringBuilder sb, String s) {
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> sb.append("\\\"");
        case '\\' -> sb.append("\\\\");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        case '\b' -> sb.append("\\b");
        case '\f' -> sb.append("\\f");
        default -> {
          // Also escape U+2028/2029 so the output is safe inside <script> and JS strings.
          if (c < 0x20 || c == ' ' || c == ' ') sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
        }
      }
    }
    sb.append('"');
  }

  // ------------------------------------------------------------------------------ parser

  /** Thrown for malformed JSON. */
  public static final class ParseException extends IllegalArgumentException {
    private static final long serialVersionUID = 1L;

    ParseException(String message) {
      super(message);
    }
  }

  private static final class Parser {
    private static final int MAX_DEPTH = 64;
    private final String s;
    private int i;
    private int depth;

    Parser(String s) {
      this.s = s == null ? "" : s;
    }

    boolean atEnd() {
      return i >= s.length();
    }

    ParseException error(String message) {
      return new ParseException(message + " at position " + i);
    }

    void skipWhitespace() {
      while (i < s.length()) {
        char c = s.charAt(i);
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
        else break;
      }
    }

    Object value() {
      if (atEnd()) throw error("Unexpected end of JSON");
      char c = s.charAt(i);
      return switch (c) {
        case '{' -> object();
        case '[' -> array();
        case '"' -> string();
        case 't' -> literal("true", Boolean.TRUE);
        case 'f' -> literal("false", Boolean.FALSE);
        case 'n' -> literal("null", null);
        default -> {
          if (c == '-' || (c >= '0' && c <= '9')) yield number();
          throw error("Unexpected character '" + c + "'");
        }
      };
    }

    private Object literal(String word, Object result) {
      if (!s.startsWith(word, i)) throw error("Invalid literal");
      i += word.length();
      return result;
    }

    private Map<String, Object> object() {
      if (++depth > MAX_DEPTH) throw error("JSON nested too deeply");
      Map<String, Object> out = new LinkedHashMap<>();
      i++; // {
      skipWhitespace();
      if (i < s.length() && s.charAt(i) == '}') {
        i++;
        depth--;
        return out;
      }
      while (true) {
        skipWhitespace();
        if (atEnd() || s.charAt(i) != '"') throw error("Expected a string key");
        String key = string();
        skipWhitespace();
        if (atEnd() || s.charAt(i) != ':') throw error("Expected ':'");
        i++;
        skipWhitespace();
        out.put(key, value());
        skipWhitespace();
        if (atEnd()) throw error("Unterminated object");
        char c = s.charAt(i++);
        if (c == '}') break;
        if (c != ',') throw error("Expected ',' or '}'");
      }
      depth--;
      return out;
    }

    private List<Object> array() {
      if (++depth > MAX_DEPTH) throw error("JSON nested too deeply");
      List<Object> out = new ArrayList<>();
      i++; // [
      skipWhitespace();
      if (i < s.length() && s.charAt(i) == ']') {
        i++;
        depth--;
        return out;
      }
      while (true) {
        skipWhitespace();
        out.add(value());
        skipWhitespace();
        if (atEnd()) throw error("Unterminated array");
        char c = s.charAt(i++);
        if (c == ']') break;
        if (c != ',') throw error("Expected ',' or ']'");
      }
      depth--;
      return out;
    }

    private String string() {
      i++; // opening quote
      StringBuilder sb = new StringBuilder();
      while (true) {
        if (atEnd()) throw error("Unterminated string");
        char c = s.charAt(i++);
        if (c == '"') return sb.toString();
        if (c != '\\') {
          sb.append(c);
          continue;
        }
        if (atEnd()) throw error("Unterminated escape");
        char e = s.charAt(i++);
        switch (e) {
          case '"', '\\', '/' -> sb.append(e);
          case 'b' -> sb.append('\b');
          case 'f' -> sb.append('\f');
          case 'n' -> sb.append('\n');
          case 'r' -> sb.append('\r');
          case 't' -> sb.append('\t');
          case 'u' -> {
            if (i + 4 > s.length()) throw error("Bad unicode escape");
            try {
              sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
            } catch (NumberFormatException ex) {
              throw error("Bad unicode escape");
            }
            i += 4;
          }
          default -> throw error("Bad escape '\\" + e + "'");
        }
      }
    }

    private Double number() {
      int start = i;
      if (s.charAt(i) == '-') i++;
      while (i < s.length()) {
        char c = s.charAt(i);
        if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') i++;
        else break;
      }
      try {
        return Double.parseDouble(s.substring(start, i));
      } catch (NumberFormatException e) {
        throw error("Bad number");
      }
    }
  }
}
