#include <Arduino.h>

const int WARNING_LED_PIN = 2;
const int BUZZER_PIN = 13;

// Replace this value after measuring the deployed firmware image hash.
// This is a simulated secure-boot guard for project demonstration. On a
// production ESP32, enable ESP-IDF Secure Boot V2 and Flash Encryption.
const char *EXPECTED_FIRMWARE_HASH = "SIMULATED_APPROVED_FIRMWARE_HASH";

uint32_t crc32Update(uint32_t crc, uint8_t data) {
  crc ^= data;
  for (int bit = 0; bit < 8; bit++) {
    uint32_t mask = -(crc & 1);
    crc = (crc >> 1) ^ (0xEDB88320 & mask);
  }
  return crc;
}

uint32_t crc32String(const String &value) {
  uint32_t crc = 0xFFFFFFFF;
  for (unsigned int i = 0; i < value.length(); i++) {
    crc = crc32Update(crc, static_cast<uint8_t>(value[i]));
  }
  return ~crc;
}

String simulatedFirmwareHash() {
  // Keep this deterministic for the prototype. In a production ESP-IDF build,
  // verify the signed bootloader/app image instead of hashing this string.
  return "SIMULATED_APPROVED_FIRMWARE_HASH";
}

void triggerSecurityAlarm() {
  digitalWrite(WARNING_LED_PIN, HIGH);
  tone(BUZZER_PIN, 2200, 500);
}

bool verifyFirmwareBeforeStartup() {
  String measuredHash = simulatedFirmwareHash();
  if (measuredHash != EXPECTED_FIRMWARE_HASH) {
    // Warning outputs are reserved for anomaly alarms only.
    Serial.println("SECURE_BOOT_REJECTED");
    return false;
  }

  Serial.println("SECURE_BOOT_VERIFIED");
  return true;
}

void setup() {
  pinMode(WARNING_LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(WARNING_LED_PIN, LOW);

  Serial.begin(115200);
  delay(1000);

  if (!verifyFirmwareBeforeStartup()) {
    while (true) {
      delay(1000);
    }
  }
}

void loop() {
  // Replace these simulated values with real sensor reads.
  float vibration = 0.10 + (random(0, 8) / 100.0);
  float temperature = 30.0 + (random(0, 30) / 10.0);
  float pressure = 4.0 + (random(0, 25) / 10.0);

  String packet = String(vibration, 3) + "," + String(temperature, 2) + "," + String(pressure, 2);
  uint32_t checksum = crc32String(packet);

  Serial.print(packet);
  Serial.print(",");
  if (checksum < 0x10000000) {
    Serial.print("0");
  }
  Serial.println(checksum, HEX);

  delay(1000);
}
