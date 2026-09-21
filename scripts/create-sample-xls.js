import fs from "node:fs/promises";
import path from "node:path";
import XLSX from "xlsx";

const rows = [
  {
    Timestamp: "9/16/2026 16:49:12",
    "Your Good Name*": "Sindhu",
    "Company / Organization*": "Best infra",
    "Mobile Number / WhatsApp*": "939291760",
    "Email ID": "beligesindhu4567@gmail.com",
    "Area of Interest*": "EV Charging Infrastructure",
  },
  {
    Timestamp: "9/16/2026 18:17:47",
    "Your Good Name*": "Vishal",
    "Company / Organization*": "Best Infra",
    "Mobile Number / WhatsApp*": "8830100301",
    "Email ID": "vishalpkale7262@gmail.com",
    "Area of Interest*": "Software / Digital Solutions",
  },
  {
    Timestamp: "9/17/2026 10:05:00",
    "Your Good Name*": "Asha",
    "Company / Organization*": "Metro Grid",
    "Mobile Number / WhatsApp*": "9000000000",
    "Email ID": "",
    "Area of Interest*": "Renewable Energy",
  },
  {
    Timestamp: "9/17/2026 11:20:00",
    "Your Good Name*": "Vishal",
    "Company / Organization*": "Best Infra",
    "Mobile Number / WhatsApp*": "8830100301",
    "Email ID": "vishalpkale7262@gmail.com",
    "Area of Interest*": "Software / Digital Solutions",
  },
];

const workbook = XLSX.utils.book_new();
const sheet = XLSX.utils.json_to_sheet(rows);
XLSX.utils.book_append_sheet(workbook, sheet, "Form Responses 1");

const outDir = path.resolve("sample");
await fs.mkdir(outDir, { recursive: true });
XLSX.writeFile(workbook, path.join(outDir, "sample-leads.xls"), { bookType: "xls" });
console.log("Wrote sample/sample-leads.xls");
