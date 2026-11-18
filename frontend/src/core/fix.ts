/** One GPS reading from the phone. */
export interface Fix {
  lat: number;
  lng: number;
  /** 68% confidence radius in metres. */
  accuracy: number;
  /** Ground speed in m/s if the device reported it. */
  speed: number | null;
  /** Course over ground in degrees if the device reported it. */
  heading: number | null;
  /** Milliseconds on the phone's clock. */
  timestamp: number;
}
