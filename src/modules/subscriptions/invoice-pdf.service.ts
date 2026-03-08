// src/modules/subscriptions/invoice-pdf.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { Payment } from '../payments/entities/payment.entity';
import { PaymentStatus } from '@common/enums/payment.enum';

@Injectable()
export class InvoicePdfService implements OnModuleInit {
  private logoBuffer: Buffer | null = null;

  async onModuleInit() {
    try {
      const response = await fetch(
        'https://dev.smart-life.sa/assets/smartlife-text-black-THaafVXq.png',
      );
      const arrayBuffer = await response.arrayBuffer();
      this.logoBuffer = Buffer.from(arrayBuffer);
    } catch {
      // Logo fetch failed — will fall back to text
      this.logoBuffer = null;
    }
  }

  generate(payment: Payment): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const invoiceNumber = `INV-${payment.createdAt.getFullYear()}-${payment.id.slice(0, 8).toUpperCase()}`;
      const pageWidth = doc.page.width;
      const contentWidth = pageWidth - 100; // 50px margin each side

      // ── Header ────────────────────────────────────────────────────────────
      if (this.logoBuffer) {
        doc.image(this.logoBuffer, 50, 45, { width: 140 });
      } else {
        // Fallback if logo unavailable
        doc
          .fontSize(28)
          .font('Helvetica-Bold')
          .fillColor('#1a1a2e')
          .text('Smart Life', 50, 50);
      }

      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#6b7280')
        .text('IoT Platform', 50, 96)
        .text('iot@smart-life.sa', 50, 110)
        .text('smart-life.sa', 50, 124);

      // Invoice title block (top right)
      doc
        .fontSize(32)
        .font('Helvetica-Bold')
        .fillColor('#1a1a2e')
        .text('INVOICE', 0, 50, { align: 'right' });

      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#6b7280')
        .text(invoiceNumber, 0, 92, { align: 'right' });

      const statusColor = payment.status === PaymentStatus.SUCCEEDED ? '#16a34a' : '#dc2626';
      doc
        .fontSize(10)
        .font('Helvetica-Bold')
        .fillColor(statusColor)
        .text(payment.status.toUpperCase(), 0, 108, { align: 'right' });

      // ── Divider ───────────────────────────────────────────────────────────
      doc
        .moveTo(50, 140)
        .lineTo(pageWidth - 50, 140)
        .lineWidth(1)
        .strokeColor('#e5e7eb')
        .stroke();

      // ── Dates block ───────────────────────────────────────────────────────
      const dateY = 160;
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#6b7280');
      doc.text('INVOICE DATE', 50, dateY);
      doc.text('PAYMENT DATE', 220, dateY);
      doc.text('BILLING PERIOD', 390, dateY);

      doc.fontSize(10).font('Helvetica').fillColor('#1a1a2e');
      doc.text(this.formatDate(payment.createdAt), 50, dateY + 14);
      doc.text(payment.paidAt ? this.formatDate(payment.paidAt) : '—', 220, dateY + 14);
      doc.text(payment.metadata?.billingPeriod ?? '—', 390, dateY + 14);

      // ── Line items table ──────────────────────────────────────────────────
      const tableY = 220;

      // Table header
      doc
        .rect(50, tableY, contentWidth, 28)
        .fillColor('#f3f4f6')
        .fill();

      doc
        .fontSize(9)
        .font('Helvetica-Bold')
        .fillColor('#374151')
        .text('DESCRIPTION', 62, tableY + 9)
        .text('PLAN', 310, tableY + 9)
        .text('PERIOD', 390, tableY + 9)
        .text('AMOUNT', 0, tableY + 9, { align: 'right' });

      // Table row
      const rowY = tableY + 28;
      doc
        .rect(50, rowY, contentWidth, 40)
        .fillColor('#ffffff')
        .fill()
        .rect(50, rowY, contentWidth, 40)
        .lineWidth(0.5)
        .strokeColor('#e5e7eb')
        .stroke();

      const planName = this.capitalize(payment.metadata?.plan ?? 'Subscription');
      const period = this.capitalize(payment.metadata?.billingPeriod ?? '');

      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#1a1a2e')
        .text(payment.description ?? `Smart Life ${planName} Plan`, 62, rowY + 14)
        .text(planName, 310, rowY + 14)
        .text(period, 390, rowY + 14);

      doc
        .fontSize(10)
        .font('Helvetica-Bold')
        .fillColor('#1a1a2e')
        .text(`${Number(payment.amount).toFixed(2)} ${payment.currency}`, 0, rowY + 14, { align: 'right' });

      // ── Totals block ──────────────────────────────────────────────────────
      const totalsY = rowY + 60;
      const labelX = pageWidth - 200;
      const valueX = pageWidth - 50;

      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#6b7280')
        .text('Subtotal', labelX, totalsY)
        .text(`${Number(payment.amount).toFixed(2)} ${payment.currency}`, 0, totalsY, { align: 'right' });

      doc
        .fontSize(9)
        .fillColor('#6b7280')
        .text('VAT (15%)', labelX, totalsY + 18)
        .text('Included', 0, totalsY + 18, { align: 'right' });

      // Total divider
      doc
        .moveTo(labelX, totalsY + 36)
        .lineTo(pageWidth - 50, totalsY + 36)
        .lineWidth(0.5)
        .strokeColor('#d1d5db')
        .stroke();

      doc
        .fontSize(12)
        .font('Helvetica-Bold')
        .fillColor('#1a1a2e')
        .text('Total', labelX, totalsY + 44)
        .text(`${Number(payment.amount).toFixed(2)} ${payment.currency}`, 0, totalsY + 44, { align: 'right' });

      // ── Payment method block ──────────────────────────────────────────────
      const methodY = totalsY + 90;
      doc
        .rect(50, methodY, contentWidth, 50)
        .fillColor('#f9fafb')
        .fill()
        .rect(50, methodY, contentWidth, 50)
        .lineWidth(0.5)
        .strokeColor('#e5e7eb')
        .stroke();

      doc
        .fontSize(9)
        .font('Helvetica-Bold')
        .fillColor('#6b7280')
        .text('PAYMENT METHOD', 62, methodY + 10);

      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#1a1a2e')
        .text(
          `${this.capitalize(payment.method)} via ${this.capitalize(payment.provider)}`,
          62,
          methodY + 24,
        );

      if (payment.paymentIntentId) {
        doc
          .fontSize(9)
          .font('Helvetica')
          .fillColor('#9ca3af')
          .text(`Ref: ${payment.paymentIntentId}`, 300, methodY + 24);
      }

      // ── Footer ────────────────────────────────────────────────────────────
      const footerY = doc.page.height - 80;
      doc
        .moveTo(50, footerY)
        .lineTo(pageWidth - 50, footerY)
        .lineWidth(0.5)
        .strokeColor('#e5e7eb')
        .stroke();

      doc
        .fontSize(8)
        .font('Helvetica')
        .fillColor('#9ca3af')
        .text('Smart Life IoT Platform — smart-life.sa', 50, footerY + 12, { align: 'center' })
        .text(
          'This is a computer-generated invoice and does not require a signature.',
          50,
          footerY + 26,
          { align: 'center' },
        );

      doc.end();
    });
  }

  private formatDate(date: Date): string {
    return new Date(date).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  private capitalize(str: string): string {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, ' ');
  }
}