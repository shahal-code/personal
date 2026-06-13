import os from "node:os";
import { execFile } from "node:child_process";

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 4000, windowsHide: true, ...options },
      (error, stdout) => {
        if (error) {
          resolve("");
          return;
        }

        resolve(String(stdout || "").trim());
      }
    );
  });
}

function runShell(script) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      resolve("");
      return;
    }

    execFile("sh", ["-lc", script], { timeout: 4000 }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }

      resolve(String(stdout || "").trim());
    });
  });
}

async function readBatteryAndTemperatureFromTermux() {
  const output = await runCommand("termux-battery-status", []);

  if (!output) {
    return null;
  }

  try {
    const parsed = JSON.parse(output);
    const percentage = Number(parsed.percentage);
    const temperature = Number(parsed.temperature);
    const status = String(parsed.status || "").toUpperCase();

    return {
      battery: {
        percentage: Number.isFinite(percentage) ? percentage : null,
        charging: ["CHARGING", "FULL"].includes(status),
        source: "termux-battery-status",
      },
      temperature: {
        celsius: Number.isFinite(temperature) ? Number(temperature.toFixed(1)) : null,
        source: "termux-battery-status",
      },
    };
  } catch {
    return null;
  }
}

async function readBatteryAndTemperatureFromDumpsys() {
  const output = await runShell("dumpsys battery");

  if (!output) {
    return null;
  }

  const levelMatch = output.match(/^\s*level:\s*(\d+)/im);
  const presentMatch = output.match(/^\s*present:\s*(true|false)/im);
  const statusMatch = output.match(/^\s*status:\s*(\d+)/im);
  const temperatureMatch = output.match(/^\s*temperature:\s*(-?\d+)/im);

  if (!levelMatch && !temperatureMatch) {
    return null;
  }

  const present = presentMatch ? presentMatch[1] === "true" : null;
  if (present === false) {
    return null;
  }

  const percentage = levelMatch ? Number(levelMatch[1]) : null;
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const temperatureTenths = temperatureMatch ? Number(temperatureMatch[1]) : null;

  return {
    battery: {
      percentage: Number.isFinite(percentage) ? percentage : null,
      charging: status == null ? null : status === 2 || status === 5,
      source: "dumpsys battery",
    },
    temperature: {
      celsius:
        Number.isFinite(temperatureTenths) && temperatureTenths > 0
          ? Number((temperatureTenths / 10).toFixed(1))
          : null,
      source: "dumpsys battery",
    },
  };
}

async function readBatteryInfo() {
  const termux = await readBatteryAndTemperatureFromTermux();
  if (termux) {
    return termux.battery;
  }

  const output = await runCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "$battery = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus; if ($battery) { $battery | ConvertTo-Json -Compress }"]
  );

  if (!output) {
    return { percentage: null, charging: null, source: "Battery status unavailable" };
  }

  try {
    const parsed = JSON.parse(output);
    const percentage = Number(parsed.EstimatedChargeRemaining);
    const batteryStatus = Number(parsed.BatteryStatus);
    const charging = [6, 7, 8, 9, 10, 11].includes(batteryStatus);

    return {
      percentage: Number.isFinite(percentage) ? percentage : null,
      charging,
      source: "Win32_Battery",
    };
  } catch {
    return { percentage: null, charging: null, source: "Battery status unavailable" };
  }
}

async function readTemperatureInfo() {
  const termux = await readBatteryAndTemperatureFromTermux();
  if (termux) {
    return termux.temperature;
  }

  const output = await runCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "$sensor = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1 CurrentTemperature; if ($sensor) { $sensor | ConvertTo-Json -Compress }"]
  );

  if (!output) {
    return { celsius: null, source: "Temperature sensor unavailable" };
  }

  try {
    const parsed = JSON.parse(output);
    const currentTemperature = Number(parsed.CurrentTemperature);
    const celsius = Number.isFinite(currentTemperature) ? currentTemperature / 10 - 273.15 : null;

    return {
      celsius: celsius == null ? null : Number(celsius.toFixed(1)),
      source: "MSAcpi_ThermalZoneTemperature",
    };
  } catch {
    return { celsius: null, source: "Temperature sensor unavailable" };
  }
}

function formatUptime(seconds) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

export async function getSystemStatus() {
  const [battery, temperature] = await Promise.all([readBatteryInfo(), readTemperatureInfo()]);
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: {
      seconds: Math.floor(os.uptime()),
      humanReadable: formatUptime(os.uptime()),
    },
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: totalMemory - freeMemory,
    },
    battery,
    batteryPercentage: battery.percentage,
    temperature,
    temperatureCelsius: temperature.celsius,
  };
}
