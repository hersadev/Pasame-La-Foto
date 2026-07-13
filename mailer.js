const nodemailer = require('nodemailer');

// Sin SMTP configurado (desarrollo local), el correo se imprime en el log
// en vez de enviarse, para no bloquear el flujo de recuperación de contraseña.
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
const configured = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

const transporter = configured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT || '587', 10),
      secure: parseInt(SMTP_PORT || '587', 10) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

async function sendMail({ to, subject, text, replyTo }) {
  if (!transporter) {
    console.log(`[mailer] SMTP no configurado. Correo para ${to}:\n${subject}\n${text}`);
    return;
  }
  await transporter.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text, replyTo });
}

module.exports = { sendMail };
