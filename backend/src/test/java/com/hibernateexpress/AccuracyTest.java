package com.hibernateexpress;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.hibernateexpress.sim.AccuracySimulation;
import com.hibernateexpress.sim.AccuracySimulation.Ride;
import com.hibernateexpress.sim.AccuracySimulation.Scenario;
import com.hibernateexpress.sim.AccuracySimulation.Summary;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * End-to-end alarm accuracy: hundreds of simulated rides with noisy GPS through the real engine.
 * Every ride must ring, for the right reason, inside the scenario's early/late budget.
 */
class AccuracyTest {

  static Stream<Arguments> scenarios() {
    List<Scenario> all = new ArrayList<>(AccuracySimulation.distanceScenarios());
    all.addAll(AccuracySimulation.timeScenarios());
    return all.stream().map(sc -> Arguments.of(sc.name(), sc));
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("scenarios")
  void alarmRingsOnTime(String name, Scenario scenario) {
    Summary summary = AccuracySimulation.run(scenario);
    assertEquals(scenario.rides(), summary.fired(), "every ride must ring");
    for (Ride ride : summary.rides()) {
      assertEquals(scenario.expectedReason(), ride.reason(), "rang for the wrong reason");
    }
    for (double error : summary.errors()) {
      assertTrue(error > -scenario.lateBudget() || (scenario.lateBudget() == 0 && error >= 0), "late by " + -error);
      assertTrue(error < scenario.earlyBudget(), "early by " + error);
    }
  }
}
