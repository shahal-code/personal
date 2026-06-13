import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";

let previousNetworkSample = null;

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile(
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
      child.on("error", () => resolve(""));
    } catch {
      resolve("");
    }
  });
}

function runShell(script) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      resolve("");
      return;
    }

    try {
      const child = execFile("sh", ["-lc", script], { timeout: 4000 }, (error, stdout) => {
        if (error) {
          resolve("");
          return;
        }

        resolve(String(stdout || "").trim());
      });
      child.on("error", () => resolve(""));
    } catch {
      resolve("");
    }
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

function cpuSnapshot() {
  return os.cpus().reduce(
    (totals, cpu) => {
      const times = Object.values(cpu.times);
      totals.idle += cpu.times.idle;
      totals.total += times.reduce((sum, value) => sum + value, 0);
      return totals;
    },
    { idle: 0, total: 0 }
  );
}

async function readProcCpuSnapshot() {
  try {
    const contents = await fs.readFile("/proc/stat", "utf8");
    const cpuLine = contents.split("\n").find((line) => line.startsWith("cpu "));
    if (!cpuLine) {
      return null;
    }

    const values = cpuLine.trim().split(/\s+/).slice(1).map(Number);
    if (values.length < 4 || values.some((value) => !Number.isFinite(value))) {
      return null;
    }

    const idle = values[3] + (values[4] || 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

async function readTopCpuPercentage() {
  const output =
    (await runCommand("top", ["-b", "-n", "2", "-d", "1"])) ||
    (await runCommand("top", ["-n", "2", "-d", "1"]));
  if (!output) {
    return null;
  }

  const procpsMatches = [...output.matchAll(/Cpu\(s\).*?([\d.]+)\s*id\b/gi)];
  const procpsIdle = procpsMatches.at(-1);
  if (procpsIdle?.[1]) {
    const idle = Number(procpsIdle[1]);
    return Number.isFinite(idle) ? Math.max(0, Math.min(100, 100 - idle)) : null;
  }

  const androidMatches = [...output.matchAll(/([\d.]+)%cpu\b[^\n]*?([\d.]+)%idle\b/gi)];
  const androidCpu = androidMatches.at(-1);
  if (androidCpu?.[1] && androidCpu?.[2]) {
    const total = Number(androidCpu[1]);
    const idle = Number(androidCpu[2]);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(idle)) {
      return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
    }
  }

  const userSystemMatches = [
    ...output.matchAll(/([\d.]+)%user\b[^\n]*?([\d.]+)%sys\b/gi),
  ];
  const userSystem = userSystemMatches.at(-1);
  if (userSystem?.[1] && userSystem?.[2]) {
    const user = Number(userSystem[1]);
    const system = Number(userSystem[2]);
    if (Number.isFinite(user) && Number.isFinite(system)) {
      return Math.max(0, Math.min(100, user + system));
    }
  }

  return null;
}

async function readDumpsysCpuPercentage() {
  const output = await runCommand("dumpsys", ["cpuinfo"]);
  const match = output.match(/([\d.]+)%\s+TOTAL\b/i);
  const percentage = Number(match?.[1]);
  return Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : null;
}

async function readCpuUsage() {
  const first = (await readProcCpuSnapshot()) || cpuSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const second = (await readProcCpuSnapshot()) || cpuSnapshot();
  const idle = second.idle - first.idle;
  const total = second.total - first.total;
  let percentage = total > 0 ? (1 - idle / total) * 100 : null;
  let source = first && second ? "system counters" : null;

  if (!Number.isFinite(percentage) || percentage <= 0) {
    const topPercentage = await readTopCpuPercentage();
    if (Number.isFinite(topPercentage) && topPercentage > 0) {
      percentage = topPercentage;
      source = "top";
    }
  }

  if (!Number.isFinite(percentage) || percentage <= 0) {
    const dumpsysPercentage = await readDumpsysCpuPercentage();
    if (Number.isFinite(dumpsysPercentage)) {
      percentage = dumpsysPercentage;
      source = "dumpsys";
    }
  }

  const coreCount = os.cpus().length || os.availableParallelism?.() || null;

  return {
    percentage: Number.isFinite(percentage)
      ? Math.round(Math.max(0, Math.min(100, percentage)) * 10) / 10
      : null,
    cores: coreCount || null,
    source: source || "unavailable",
  };
}

async function readLinuxNetworkCounters() {
  try {
    const contents = await fs.readFile("/proc/net/dev", "utf8");
    return contents
      .split("\n")
      .slice(2)
      .reduce(
        (totals, line) => {
          const [interfaceName, values] = line.trim().split(":");
          if (!interfaceName || !values || interfaceName.trim() === "lo") {
            return totals;
          }

          const fields = values.trim().split(/\s+/).map(Number);
          totals.receivedBytes += Number.isFinite(fields[0]) ? fields[0] : 0;
          totals.sentBytes += Number.isFinite(fields[8]) ? fields[8] : 0;
          return totals;
        },
        { receivedBytes: 0, sentBytes: 0 }
      );
  } catch {
    return null;
  }
}

async function readWindowsNetworkCounters() {
  const output = await runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$stats = Get-NetAdapterStatistics -ErrorAction SilentlyContinue | Measure-Object -Property ReceivedBytes,SentBytes -Sum; if ($stats) { [pscustomobject]@{ receivedBytes = $stats[0].Sum; sentBytes = $stats[1].Sum } | ConvertTo-Json -Compress }",
  ]);

  if (!output) {
    return null;
  }

  try {
    const parsed = JSON.parse(output);
    return {
      receivedBytes: Number(parsed.receivedBytes) || 0,
      sentBytes: Number(parsed.sentBytes) || 0,
    };
  } catch {
    return null;
  }
}

async function readNetworkStatus() {
  const interfaces = os.networkInterfaces();
  const connected = Object.values(interfaces)
    .flat()
    .some((address) => address && !address.internal && address.family === "IPv4");
  const counters =
    process.platform === "win32"
      ? await readWindowsNetworkCounters()
      : await readLinuxNetworkCounters();
  const now = Date.now();
  let downloadBytesPerSecond = null;
  let uploadBytesPerSecond = null;

  if (counters && previousNetworkSample) {
    const elapsedSeconds = (now - previousNetworkSample.at) / 1000;
    if (elapsedSeconds > 0) {
      downloadBytesPerSecond = Math.max(
        0,
        Math.round((counters.receivedBytes - previousNetworkSample.receivedBytes) / elapsedSeconds)
      );
      uploadBytesPerSecond = Math.max(
        0,
        Math.round((counters.sentBytes - previousNetworkSample.sentBytes) / elapsedSeconds)
      );
    }
  }

  if (counters) {
    previousNetworkSample = { ...counters, at: now };
  }

  return {
    connected,
    type: connected ? "Network connected" : "Offline",
    downloadBytesPerSecond,
    uploadBytesPerSecond,
  };
}

export async function getSystemStatus() {
  const [battery, temperature, cpu, network] = await Promise.all([
    readBatteryInfo(),
    readTemperatureInfo(),
    readCpuUsage(),
    readNetworkStatus(),
  ]);
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();

  return {
    uptime: {
      humanReadable: formatUptime(os.uptime()),
    },
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: totalMemory - freeMemory,
    },
    battery: {
      percentage: battery.percentage,
      charging: battery.charging,
    },
    temperature: {
      celsius: temperature.celsius,
    },
    cpu,
    network,
  };
}
