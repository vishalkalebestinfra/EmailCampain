export const SUMMIT_TEMPLATE_ID = "summit-thank-you";

const EMAIL_COLUMN = {
  key: "email",
  label: "Email ID",
  required: true,
  aliases: ["email id", "email", "email address", "e-mail"],
};

export const TEMPLATES = [
  {
    id: SUMMIT_TEMPLATE_ID,
    name: "Energy Summit thank-you",
    htmlPath: "Template/index.html",
    mode: "interest-brochures",
    columns: [
      EMAIL_COLUMN,
      {
        key: "timestamp",
        label: "Timestamp",
        required: false,
        aliases: ["timestamp", "time stamp"],
      },
      {
        key: "name",
        label: "Name",
        required: false,
        aliases: ["your good name", "name", "full name", "contact name"],
      },
      {
        key: "company",
        label: "Company",
        required: false,
        aliases: ["company / organization", "company", "organization", "organisation"],
      },
      {
        key: "mobile",
        label: "Mobile",
        required: false,
        aliases: ["mobile number / whatsapp", "mobile", "whatsapp", "phone", "mobile number"],
      },
      {
        key: "interest",
        label: "Area of Interest",
        required: true,
        aliases: ["area of interest", "interest"],
      },
    ],
  },
];

export function listTemplates() {
  return TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    columns: template.columns.map((column) => ({
      key: column.key,
      label: column.label,
      required: column.key === "email" ? true : Boolean(column.required),
    })),
  }));
}

export function getTemplate(id) {
  return TEMPLATES.find((template) => template.id === id) || null;
}

export function columnsForTemplate(template) {
  const columns = template.columns.map((column) => ({ ...column }));
  const email = columns.find((column) => column.key === "email");
  if (!email) {
    columns.unshift({ ...EMAIL_COLUMN });
  } else {
    email.required = true;
  }
  return columns;
}
