import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';
import type { Shipment } from '../types';

interface Props {
  shipment?: Shipment;
}

const SHIPMENT_TYPES = ['Standard', 'Express', 'Priority', 'Freight', 'Air Freight', 'Sea Freight', 'International', 'Courier'];
const COMMODITY_TYPES = ['Electronics', 'Machinery & Parts', 'Clothing & Textiles', 'Pharmaceuticals', 'Food & Beverages', 'Chemicals', 'Automotive Parts', 'Medical Devices', 'Furniture', 'Books & Documents', 'Jewelry & Valuables', 'Hazardous Materials', 'Other'];
const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  background: 'rgba(15,23,42,0.6)',
  border: '1px solid rgba(148,163,184,0.2)',
  borderRadius: '10px',
  color: '#e2e8f0',
  fontSize: '14px',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.2s',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  color: '#64748b',
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  marginBottom: '6px',
};

const sectionHeaderStyle: React.CSSProperties = {
  color: '#818cf8',
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
  paddingBottom: '10px',
  borderBottom: '1px solid rgba(99,102,241,0.2)',
  marginBottom: '16px',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

export default function ShipmentForm({ shipment }: Props) {
  const navigate = useNavigate();
  const isEditing = !!shipment;
  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useState({
    title:                shipment?.title || '',
    senderName:           shipment?.senderName || '',
    receiverName:         shipment?.receiverName || '',
    origin:               shipment?.origin || '',
    destination:          shipment?.destination || '',
    shipmentType:         shipment?.shipmentType || 'Standard',
    weight:               shipment?.weight?.toString() || '',
    description:          shipment?.description || '',
    estimatedDeliveryDate: shipment?.estimatedDeliveryDate
      ? new Date(shipment.estimatedDeliveryDate).toISOString().split('T')[0] : '',
    // vNext fields
    carrierName:          shipment?.carrierName || '',
    commodityType:        shipment?.commodityType || '',
    hsCodeHint:           shipment?.hsCodeHint || '',
    isDangerousGoods:     shipment?.isDangerousGoods || false,
    dangerousGoodsClass:  shipment?.dangerousGoodsClass || '',
    incoterms:            shipment?.incoterms || '',
    declaredValue:        shipment?.declaredValue?.toString() || '',
    currencyCode:         shipment?.currencyCode || 'USD',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value,
    }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload: Record<string, unknown> = {
        title: formData.title,
        senderName: formData.senderName,
        receiverName: formData.receiverName,
        origin: formData.origin,
        destination: formData.destination,
        shipmentType: formData.shipmentType,
        weight: parseFloat(formData.weight),
        description: formData.description || undefined,
        estimatedDeliveryDate: formData.estimatedDeliveryDate || undefined,
        // vNext
        carrierName: formData.carrierName || undefined,
        commodityType: formData.commodityType || undefined,
        hsCodeHint: formData.hsCodeHint || undefined,
        isDangerousGoods: formData.isDangerousGoods,
        dangerousGoodsClass: formData.dangerousGoodsClass || undefined,
        incoterms: formData.incoterms || undefined,
        declaredValue: formData.declaredValue ? parseFloat(formData.declaredValue) : undefined,
        currencyCode: formData.currencyCode || 'USD',
      };

      if (isEditing) {
        await api.put(`/shipments/${shipment.id}`, payload);
        toast.success('Shipment updated successfully');
        navigate('/shipments');
      } else {
        const { data } = await api.post('/shipments', payload);
        toast.success(`✦ Shipment created! AI route analysis initiated — ${data.trackingNumber}`, { duration: 5000 });
        navigate('/shipments');
      }
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to save shipment');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* ── Section 1: Parties ──────────────────────────────────────────────── */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(15,23,42,0.8) 0%, rgba(30,41,59,0.8) 100%)',
        border: '1px solid rgba(148,163,184,0.12)',
        borderRadius: '16px', padding: '24px',
      }}>
        <div style={sectionHeaderStyle}><span>👤</span> Shipment Parties</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="title" style={labelStyle}>Shipment Title *</label>
            <input id="title" name="title" type="text" required
              value={formData.title} onChange={handleChange}
              placeholder="e.g., Q3 Electronics Shipment to Hamburg"
              style={inputStyle} />
          </div>
          <div>
            <label htmlFor="senderName" style={labelStyle}>Sender / Shipper *</label>
            <input id="senderName" name="senderName" type="text" required
              value={formData.senderName} onChange={handleChange}
              placeholder="Company or person name" style={inputStyle} />
          </div>
          <div>
            <label htmlFor="receiverName" style={labelStyle}>Receiver / Consignee *</label>
            <input id="receiverName" name="receiverName" type="text" required
              value={formData.receiverName} onChange={handleChange}
              placeholder="Company or person name" style={inputStyle} />
          </div>
        </div>
      </div>

      {/* ── Section 2: Route ────────────────────────────────────────────────── */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(15,23,42,0.8) 0%, rgba(30,41,59,0.8) 100%)',
        border: '1px solid rgba(148,163,184,0.12)',
        borderRadius: '16px', padding: '24px',
      }}>
        <div style={sectionHeaderStyle}><span>🗺️</span> Route & Logistics</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div>
            <label htmlFor="origin" style={labelStyle}>Origin *</label>
            <input id="origin" name="origin" type="text" required
              value={formData.origin} onChange={handleChange}
              placeholder="e.g., New York, USA" style={inputStyle} />
          </div>
          <div>
            <label htmlFor="destination" style={labelStyle}>Destination *</label>
            <input id="destination" name="destination" type="text" required
              value={formData.destination} onChange={handleChange}
              placeholder="e.g., Hamburg, Germany" style={inputStyle} />
          </div>
          <div>
            <label htmlFor="shipmentType" style={labelStyle}>Shipment Type *</label>
            <select id="shipmentType" name="shipmentType" required
              value={formData.shipmentType} onChange={handleChange} style={inputStyle}>
              {SHIPMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="carrierName" style={labelStyle}>Carrier</label>
            <input id="carrierName" name="carrierName" type="text"
              value={formData.carrierName} onChange={handleChange}
              placeholder="e.g., FedEx, DHL, Maersk" style={inputStyle} />
          </div>
          <div>
            <label htmlFor="incoterms" style={labelStyle}>Incoterms</label>
            <select id="incoterms" name="incoterms" value={formData.incoterms} onChange={handleChange} style={inputStyle}>
              <option value="">— Select Incoterms —</option>
              {INCOTERMS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="estimatedDeliveryDate" style={labelStyle}>Est. Delivery Date</label>
            <input id="estimatedDeliveryDate" name="estimatedDeliveryDate" type="date"
              value={formData.estimatedDeliveryDate} onChange={handleChange} style={inputStyle} />
          </div>
        </div>
      </div>

      {/* ── Section 3: Cargo Intelligence ───────────────────────────────────── */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(15,23,42,0.8) 0%, rgba(30,41,59,0.8) 100%)',
        border: '1px solid rgba(148,163,184,0.12)',
        borderRadius: '16px', padding: '24px',
      }}>
        <div style={sectionHeaderStyle}><span>📦</span> Cargo Intelligence</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div>
            <label htmlFor="weight" style={labelStyle}>Weight (kg) *</label>
            <input id="weight" name="weight" type="number" step="0.01" min="0.01" required
              value={formData.weight} onChange={handleChange} placeholder="0.00" style={inputStyle} />
          </div>
          <div>
            <label htmlFor="commodityType" style={labelStyle}>Commodity Type</label>
            <select id="commodityType" name="commodityType" value={formData.commodityType} onChange={handleChange} style={inputStyle}>
              <option value="">— Select Commodity —</option>
              {COMMODITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="hsCodeHint" style={labelStyle}>HS Code Hint</label>
            <input id="hsCodeHint" name="hsCodeHint" type="text"
              value={formData.hsCodeHint} onChange={handleChange}
              placeholder="e.g., 8471.30 (laptops)" style={inputStyle} />
          </div>
          <div>
            <label htmlFor="declaredValue" style={labelStyle}>Declared Value</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <select name="currencyCode" value={formData.currencyCode} onChange={handleChange}
                style={{ ...inputStyle, width: '80px', flexShrink: 0 }}>
                {['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'AED'].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <input id="declaredValue" name="declaredValue" type="number" step="0.01" min="0"
                value={formData.declaredValue} onChange={handleChange}
                placeholder="0.00" style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>

          {/* DG checkbox */}
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
              <input type="checkbox" name="isDangerousGoods"
                checked={formData.isDangerousGoods} onChange={handleChange}
                style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: '#ef4444' }} />
              <span style={{ color: '#fca5a5', fontSize: '13px', fontWeight: 600 }}>
                ⚠️ Dangerous Goods — This shipment contains hazardous materials
              </span>
            </label>
          </div>

          {formData.isDangerousGoods && (
            <div>
              <label htmlFor="dangerousGoodsClass" style={labelStyle}>DG Class</label>
              <input id="dangerousGoodsClass" name="dangerousGoodsClass" type="text"
                value={formData.dangerousGoodsClass} onChange={handleChange}
                placeholder="e.g., Class 3 – Flammable Liquids" style={inputStyle} />
            </div>
          )}

          <div style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="description" style={labelStyle}>Goods Description</label>
            <textarea id="description" name="description" rows={3}
              value={formData.description} onChange={handleChange}
              placeholder="Detailed description of goods being shipped..."
              style={{ ...inputStyle, resize: 'vertical', minHeight: '80px' }} />
          </div>
        </div>
      </div>

      {/* ── AI Notice ──────────────────────────────────────────────────────── */}
      {!isEditing && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(139,92,246,0.06) 100%)',
          border: '1px solid rgba(99,102,241,0.25)',
          borderRadius: '12px',
          padding: '14px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}>
          <div style={{ fontSize: '20px' }}>✦</div>
          <div>
            <div style={{ color: '#a5b4fc', fontSize: '12px', fontWeight: 700, marginBottom: '2px' }}>
              AI Route Intelligence
            </div>
            <div style={{ color: '#64748b', fontSize: '12px' }}>
              After creating this shipment, Amazon Nova Lite will automatically generate a route intelligence briefing
              and a preliminary risk assessment — typically within 30 seconds.
            </div>
          </div>
        </div>
      )}

      {/* ── Actions ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '12px' }}>
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: '12px 28px',
            background: loading ? 'rgba(99,102,241,0.5)' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            fontSize: '14px',
            fontWeight: 700,
            cursor: loading ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            transition: 'all 0.2s',
          }}
        >
          {loading && (
            <div style={{ width: '14px', height: '14px', border: '2px solid rgba(255,255,255,0.3)', borderTop: '2px solid #fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          )}
          {loading ? 'Creating...' : isEditing ? '✓ Update Shipment' : '✦ Create Shipment + Start AI Analysis'}
        </button>
        <button
          type="button"
          onClick={() => navigate('/shipments')}
          style={{
            padding: '12px 20px',
            background: 'rgba(148,163,184,0.1)',
            color: '#94a3b8',
            border: '1px solid rgba(148,163,184,0.2)',
            borderRadius: '10px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
