# Hibernate Express API: build the jar with Maven (all tests must pass, including the accuracy
# simulation, so a build that would ring late never ships), then run it on a small Java runtime.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B -q package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/target/hibernate-express.jar app.jar
# API only (the phone app is on Netlify). The host sets PORT; HX_ALLOWED_ORIGIN locks CORS.
EXPOSE 8080
CMD ["java", "-XX:MaxRAMPercentage=50", "-jar", "app.jar", "serve"]
