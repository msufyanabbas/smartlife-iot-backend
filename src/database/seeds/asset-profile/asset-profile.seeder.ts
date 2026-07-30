// src/database/seeds/asset-profile/asset-profile.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant, AssetProfile } from '@modules/index.entities';
import { AssetProfileType, ProfileFieldType } from '@common/enums/index.enum';
import type { ProfileSchema } from '@common/interfaces/index.interface';
import { ISeeder } from '../seeder.interface';

/**
 * Seeds the 9 stock asset profiles (building, vehicle, shop/retail, farm,
 * warehouse, hospital, hotel, factory, custom) for EVERY tenant.
 *
 * Each profile declares a `schema.fields[]` carrying BOTH an English `label`
 * and an Arabic `labelAr` (Saudi market), plus `group`/`order` for form layout
 * and a `deviceLinkingConfig` enforced by AssetsService when devices are
 * attached. This is what the frontend renders as a dynamic bilingual form and
 * what `Asset.configuration` is keyed by.
 *
 * Profiles whose schema contains a `floors_array` field (building / hospital /
 * hotel) are the multi-floor ones — their assets drive GET /assets/:id/floors
 * and per-floor floor plans.
 *
 * Replaces the older 5-profile seeder in ../asset-profiles/ (which is no longer
 * registered in index.seeder.ts).
 *
 * Re-runnable: profiles are matched on (tenantId, name); existing rows are
 * updated in place so `type` / `schema` get backfilled on databases seeded
 * before those columns existed, and so the old `options: string[]` shape is
 * rewritten into the bilingual `{value,label,labelAr}` shape.
 */

interface ProfileDefinition {
  name: string;
  description: string;
  type: AssetProfileType;
  schema: ProfileSchema;
  default?: boolean;
  hierarchyConfig?: AssetProfile['hierarchyConfig'];
  mapConfig?: AssetProfile['mapConfig'];
  additionalInfo?: Record<string, any>;
}

/** Saudi cities, reused across profiles. */
const SAUDI_CITIES = [
  { value: 'riyadh', label: 'Riyadh', labelAr: 'الرياض' },
  { value: 'jeddah', label: 'Jeddah', labelAr: 'جدة' },
  { value: 'mecca', label: 'Mecca', labelAr: 'مكة المكرمة' },
  { value: 'medina', label: 'Medina', labelAr: 'المدينة المنورة' },
  { value: 'dammam', label: 'Dammam', labelAr: 'الدمام' },
  { value: 'khobar', label: 'Khobar', labelAr: 'الخبر' },
  { value: 'other', label: 'Other', labelAr: 'أخرى' },
];

/** Saudi administrative regions. */
const SAUDI_REGIONS = [
  { value: 'riyadh', label: 'Riyadh Region', labelAr: 'منطقة الرياض' },
  { value: 'eastern', label: 'Eastern Province', labelAr: 'المنطقة الشرقية' },
  { value: 'makkah', label: 'Makkah Region', labelAr: 'منطقة مكة المكرمة' },
  { value: 'qassim', label: 'Al-Qassim', labelAr: 'منطقة القصيم' },
  { value: 'hail', label: 'Hail', labelAr: 'منطقة حائل' },
  { value: 'tabuk', label: 'Tabuk', labelAr: 'منطقة تبوك' },
  { value: 'other', label: 'Other', labelAr: 'أخرى' },
];

const PROFILE_DEFINITIONS: ProfileDefinition[] = [
  // ── 1. Building ───────────────────────────────────────────────────────────
  {
    name: 'Building',
    description:
      'Multi-floor commercial or residential building. Supports per-floor floor plans.',
    type: AssetProfileType.BUILDING,
    schema: {
      fields: [
        { key: 'totalFloors', label: 'Total Floors', labelAr: 'إجمالي الطوابق', type: ProfileFieldType.NUMBER, required: true, min: 1, max: 200, unit: 'floors', group: 'Building Info', order: 1 },
        { key: 'totalArea', label: 'Total Area', labelAr: 'المساحة الإجمالية', type: ProfileFieldType.NUMBER, required: false, min: 1, unit: 'm²', group: 'Building Info', order: 2 },
        { key: 'yearBuilt', label: 'Year Built', labelAr: 'سنة البناء', type: ProfileFieldType.NUMBER, required: false, min: 1900, max: 2030, group: 'Building Info', order: 3 },
        {
          key: 'buildingType', label: 'Building Type', labelAr: 'نوع المبنى', type: ProfileFieldType.SELECT, required: false, group: 'Building Info', order: 4,
          options: [
            { value: 'commercial', label: 'Commercial', labelAr: 'تجاري' },
            { value: 'residential', label: 'Residential', labelAr: 'سكني' },
            { value: 'industrial', label: 'Industrial', labelAr: 'صناعي' },
            { value: 'mixed', label: 'Mixed Use', labelAr: 'متعدد الاستخدامات' },
            { value: 'government', label: 'Government', labelAr: 'حكومي' },
            { value: 'educational', label: 'Educational', labelAr: 'تعليمي' },
            { value: 'healthcare', label: 'Healthcare', labelAr: 'صحي' },
          ],
        },
        { key: 'floorsData', label: 'Floors Configuration', labelAr: 'إعداد الطوابق', type: ProfileFieldType.FLOORS_ARRAY, required: false, group: 'Floors', order: 5 },
        { key: 'address', label: 'Address', labelAr: 'العنوان', type: ProfileFieldType.TEXT, required: false, group: 'Location', order: 6 },
        { key: 'city', label: 'City', labelAr: 'المدينة', type: ProfileFieldType.SELECT, required: false, group: 'Location', order: 7, options: SAUDI_CITIES },
        { key: 'contactPerson', label: 'Contact Person', labelAr: 'الشخص المسؤول', type: ProfileFieldType.TEXT, required: false, group: 'Contact', order: 8 },
        { key: 'contactPhone', label: 'Phone', labelAr: 'رقم الهاتف', type: ProfileFieldType.TEXT, required: false, group: 'Contact', order: 9 },
      ],
      deviceLinkingConfig: { allowMultipleDevices: true, maxDevices: 1000 },
    },
    hierarchyConfig: { allowChildren: true, allowedChildTypes: ['floor', 'zone', 'room'], requireParent: false, maxDepth: 3 },
    mapConfig: { icon: 'business', iconColor: '#2196F3', markerType: 'pin', showLabel: true },
    additionalInfo: { category: 'building', icon: 'business', color: '#2196F3' },
  },

  // ── 2. Vehicle ────────────────────────────────────────────────────────────
  {
    name: 'Vehicle',
    description: 'Fleet vehicle or heavy equipment tracked by an on-board device.',
    type: AssetProfileType.VEHICLE,
    schema: {
      fields: [
        { key: 'make', label: 'Make', labelAr: 'الشركة المصنعة', type: ProfileFieldType.TEXT, required: true, group: 'Vehicle Info', order: 1 },
        { key: 'model', label: 'Model', labelAr: 'الطراز', type: ProfileFieldType.TEXT, required: true, group: 'Vehicle Info', order: 2 },
        { key: 'year', label: 'Year', labelAr: 'السنة', type: ProfileFieldType.NUMBER, required: true, min: 1990, max: 2030, group: 'Vehicle Info', order: 3 },
        { key: 'plateNumber', label: 'Plate Number', labelAr: 'رقم اللوحة', type: ProfileFieldType.TEXT, required: true, group: 'Vehicle Info', order: 4 },
        {
          key: 'vehicleType', label: 'Vehicle Type', labelAr: 'نوع المركبة', type: ProfileFieldType.SELECT, required: true, group: 'Vehicle Info', order: 5,
          options: [
            { value: 'car', label: 'Car', labelAr: 'سيارة' },
            { value: 'truck', label: 'Truck', labelAr: 'شاحنة' },
            { value: 'bus', label: 'Bus', labelAr: 'حافلة' },
            { value: 'motorcycle', label: 'Motorcycle', labelAr: 'دراجة نارية' },
            { value: 'van', label: 'Van', labelAr: 'فان' },
            { value: 'heavy_equipment', label: 'Heavy Equipment', labelAr: 'معدات ثقيلة' },
          ],
        },
        { key: 'vin', label: 'VIN', labelAr: 'رقم الهيكل', type: ProfileFieldType.TEXT, required: false, group: 'Vehicle Info', order: 6 },
        {
          key: 'fuelType', label: 'Fuel Type', labelAr: 'نوع الوقود', type: ProfileFieldType.SELECT, required: false, group: 'Specs', order: 7,
          options: [
            { value: 'petrol', label: 'Petrol', labelAr: 'بنزين' },
            { value: 'diesel', label: 'Diesel', labelAr: 'ديزل' },
            { value: 'electric', label: 'Electric', labelAr: 'كهربائي' },
            { value: 'hybrid', label: 'Hybrid', labelAr: 'هجين' },
            { value: 'lpg', label: 'LPG', labelAr: 'غاز' },
          ],
        },
        { key: 'maxSpeed', label: 'Max Speed (km/h)', labelAr: 'السرعة القصوى (كم/ساعة)', type: ProfileFieldType.NUMBER, required: false, group: 'Specs', order: 8, unit: 'km/h' },
        { key: 'driver', label: 'Driver Name', labelAr: 'اسم السائق', type: ProfileFieldType.TEXT, required: false, group: 'Assignment', order: 9 },
        { key: 'department', label: 'Department', labelAr: 'القسم', type: ProfileFieldType.TEXT, required: false, group: 'Assignment', order: 10 },
      ],
      deviceLinkingConfig: { allowMultipleDevices: true, deviceTypeFilter: ['tracker', 'sensor'], maxDevices: 10 },
    },
    hierarchyConfig: { allowChildren: false, requireParent: false },
    mapConfig: { icon: 'directions_car', iconColor: '#00BCD4', markerType: 'pin', showLabel: true },
    additionalInfo: { category: 'fleet', icon: 'directions_car', color: '#00BCD4' },
  },

  // ── 3. Farm ───────────────────────────────────────────────────────────────
  {
    name: 'Farm',
    description: 'Agricultural site divided into irrigation / crop zones.',
    type: AssetProfileType.FARM,
    schema: {
      fields: [
        { key: 'totalArea', label: 'Total Area (Hectares)', labelAr: 'المساحة الإجمالية (هكتار)', type: ProfileFieldType.NUMBER, required: true, min: 0.1, unit: 'ha', group: 'Farm Info', order: 1 },
        {
          key: 'farmType', label: 'Farm Type', labelAr: 'نوع المزرعة', type: ProfileFieldType.SELECT, required: true, group: 'Farm Info', order: 2,
          options: [
            { value: 'crop', label: 'Crop Farm', labelAr: 'مزرعة محاصيل' },
            { value: 'livestock', label: 'Livestock', labelAr: 'مزرعة مواشي' },
            { value: 'poultry', label: 'Poultry', labelAr: 'مزرعة دواجن' },
            { value: 'greenhouse', label: 'Greenhouse', labelAr: 'بيت محمي' },
            { value: 'date_palm', label: 'Date Palm', labelAr: 'مزرعة نخيل' },
            { value: 'mixed', label: 'Mixed', labelAr: 'مختلطة' },
          ],
        },
        { key: 'cropTypes', label: 'Crop Types', labelAr: 'أنواع المحاصيل', type: ProfileFieldType.TEXT, required: false, group: 'Farm Info', order: 3, placeholder: 'e.g. Wheat, Tomatoes', placeholderAr: 'مثل: قمح، طماطم' },
        {
          key: 'irrigationSystem', label: 'Irrigation System', labelAr: 'نظام الري', type: ProfileFieldType.SELECT, required: false, group: 'Irrigation', order: 4,
          options: [
            { value: 'drip', label: 'Drip Irrigation', labelAr: 'ري بالتنقيط' },
            { value: 'sprinkler', label: 'Sprinkler', labelAr: 'رش' },
            { value: 'flood', label: 'Flood', labelAr: 'غمر' },
            { value: 'none', label: 'None', labelAr: 'لا يوجد' },
          ],
        },
        { key: 'zones', label: 'Number of Zones', labelAr: 'عدد المناطق', type: ProfileFieldType.NUMBER, required: false, min: 1, group: 'Zones', order: 5 },
        {
          key: 'soilType', label: 'Soil Type', labelAr: 'نوع التربة', type: ProfileFieldType.SELECT, required: false, group: 'Soil', order: 6,
          options: [
            { value: 'sandy', label: 'Sandy', labelAr: 'رملية' },
            { value: 'clay', label: 'Clay', labelAr: 'طينية' },
            { value: 'loamy', label: 'Loamy', labelAr: 'طمية' },
            { value: 'rocky', label: 'Rocky', labelAr: 'صخرية' },
          ],
        },
        { key: 'region', label: 'Region', labelAr: 'المنطقة', type: ProfileFieldType.SELECT, required: false, group: 'Location', order: 7, options: SAUDI_REGIONS },
      ],
      deviceLinkingConfig: { allowMultipleDevices: true, maxDevices: 500 },
    },
    hierarchyConfig: { allowChildren: true, allowedChildTypes: ['zone'], requireParent: false, maxDepth: 2 },
    mapConfig: { icon: 'agriculture', iconColor: '#4CAF50', markerType: 'pin', showLabel: true },
    additionalInfo: { category: 'agriculture', icon: 'agriculture', color: '#4CAF50' },
  },

  // ── 4. Warehouse ──────────────────────────────────────────────────────────
  {
    name: 'Warehouse',
    description: 'Storage facility with racking, docking bays and capacity.',
    type: AssetProfileType.WAREHOUSE,
    schema: {
      fields: [
        { key: 'totalArea', label: 'Total Area', labelAr: 'المساحة الإجمالية', type: ProfileFieldType.NUMBER, required: true, min: 1, unit: 'm²', group: 'Warehouse Info', order: 1 },
        { key: 'storageCapacity', label: 'Storage Capacity', labelAr: 'سعة التخزين', type: ProfileFieldType.NUMBER, required: false, min: 0, unit: 'tons', group: 'Warehouse Info', order: 2 },
        { key: 'dockingBays', label: 'Docking Bays', labelAr: 'أرصفة التحميل', type: ProfileFieldType.NUMBER, required: false, min: 0, group: 'Warehouse Info', order: 3 },
        { key: 'rackingLevels', label: 'Racking Levels', labelAr: 'مستويات الرفوف', type: ProfileFieldType.NUMBER, required: false, min: 0, group: 'Warehouse Info', order: 4 },
        {
          key: 'storageType', label: 'Storage Type', labelAr: 'نوع التخزين', type: ProfileFieldType.SELECT, required: false, group: 'Storage', order: 5,
          options: [
            { value: 'ambient', label: 'Ambient', labelAr: 'درجة حرارة الغرفة' },
            { value: 'cold', label: 'Cold Storage', labelAr: 'تخزين مبرد' },
            { value: 'frozen', label: 'Frozen', labelAr: 'تجميد' },
            { value: 'hazardous', label: 'Hazardous Materials', labelAr: 'مواد خطرة' },
          ],
        },
        { key: 'temperatureControlled', label: 'Temperature Controlled', labelAr: 'متحكم بالحرارة', type: ProfileFieldType.BOOLEAN, required: false, group: 'Storage', order: 6, defaultValue: false },
        { key: 'city', label: 'City', labelAr: 'المدينة', type: ProfileFieldType.SELECT, required: false, group: 'Location', order: 7, options: SAUDI_CITIES },
      ],
      deviceLinkingConfig: { allowMultipleDevices: true, maxDevices: 500 },
    },
    hierarchyConfig: { allowChildren: true, allowedChildTypes: ['zone', 'room'], requireParent: false, maxDepth: 2 },
    mapConfig: { icon: 'warehouse', iconColor: '#795548', markerType: 'pin', showLabel: true },
    additionalInfo: { category: 'logistics', icon: 'warehouse', color: '#795548' },
  },

  // ── 5. Hospital ───────────────────────────────────────────────────────────
  {
    name: 'Hospital',
    description:
      'Healthcare facility with wards and departments. Supports per-floor floor plans.',
    type: AssetProfileType.HOSPITAL,
    schema: {
      fields: [
        { key: 'totalFloors', label: 'Total Floors', labelAr: 'إجمالي الطوابق', type: ProfileFieldType.NUMBER, required: true, min: 1, max: 200, unit: 'floors', group: 'Facility Info', order: 1 },
        { key: 'totalBeds', label: 'Total Beds', labelAr: 'إجمالي الأسرة', type: ProfileFieldType.NUMBER, required: false, min: 0, group: 'Capacity', order: 2 },
        { key: 'icuBeds', label: 'ICU Beds', labelAr: 'أسرة العناية المركزة', type: ProfileFieldType.NUMBER, required: false, min: 0, group: 'Capacity', order: 3 },
        { key: 'departments', label: 'Number of Departments', labelAr: 'عدد الأقسام', type: ProfileFieldType.NUMBER, required: false, min: 0, group: 'Capacity', order: 4 },
        {
          key: 'facilityType', label: 'Facility Type', labelAr: 'نوع المنشأة', type: ProfileFieldType.SELECT, required: false, group: 'Facility Info', order: 5,
          options: [
            { value: 'general', label: 'General Hospital', labelAr: 'مستشفى عام' },
            { value: 'specialist', label: 'Specialist Hospital', labelAr: 'مستشفى تخصصي' },
            { value: 'clinic', label: 'Clinic', labelAr: 'عيادة' },
            { value: 'medical_center', label: 'Medical Center', labelAr: 'مركز طبي' },
          ],
        },
        { key: 'floorsData', label: 'Floors Configuration', labelAr: 'إعداد الطوابق', type: ProfileFieldType.FLOORS_ARRAY, required: false, group: 'Floors', order: 6 },
        { key: 'city', label: 'City', labelAr: 'المدينة', type: ProfileFieldType.SELECT, required: false, group: 'Location', order: 7, options: SAUDI_CITIES },
        { key: 'emergencyContact', label: 'Emergency Contact', labelAr: 'رقم الطوارئ', type: ProfileFieldType.TEXT, required: false, group: 'Contact', order: 8 },
      ],
      deviceLinkingConfig: { allowMultipleDevices: true, maxDevices: 2000 },
    },
    hierarchyConfig: { allowChildren: true, allowedChildTypes: ['floor', 'zone', 'room'], requireParent: false, maxDepth: 3 },
    mapConfig: { icon: 'local_hospital', iconColor: '#E91E63', markerType: 'pin', showLabel: true },
    additionalInfo: { category: 'healthcare', icon: 'local_hospital', color: '#E91E63' },
  },

  // ── 6. Hotel ──────────────────────────────────────────────────────────────
  {
    name: 'Hotel',
    description:
      'Hospitality property with guest rooms. Supports per-floor floor plans.',
    type: AssetProfileType.HOTEL,
    schema: {
      fields: [
        { key: 'totalFloors', label: 'Total Floors', labelAr: 'إجمالي الطوابق', type: ProfileFieldType.NUMBER, required: true, min: 1, max: 200, unit: 'floors', group: 'Property Info', order: 1 },
        { key: 'totalRooms', label: 'Total Rooms', labelAr: 'إجمالي الغرف', type: ProfileFieldType.NUMBER, required: false, min: 0, group: 'Property Info', order: 2 },
        {
          key: 'starRating', label: 'Star Rating', labelAr: 'التصنيف النجمي', type: ProfileFieldType.SELECT, required: false, group: 'Property Info', order: 3,
          options: [
            { value: '1', label: '1 Star', labelAr: 'نجمة واحدة' },
            { value: '2', label: '2 Stars', labelAr: 'نجمتان' },
            { value: '3', label: '3 Stars', labelAr: 'ثلاث نجوم' },
            { value: '4', label: '4 Stars', labelAr: 'أربع نجوم' },
            { value: '5', label: '5 Stars', labelAr: 'خمس نجوم' },
          ],
        },
        {
          key: 'amenities', label: 'Amenities', labelAr: 'المرافق', type: ProfileFieldType.MULTISELECT, required: false, group: 'Amenities', order: 4,
          options: [
            { value: 'pool', label: 'Swimming Pool', labelAr: 'مسبح' },
            { value: 'gym', label: 'Gym', labelAr: 'صالة رياضية' },
            { value: 'spa', label: 'Spa', labelAr: 'منتجع صحي' },
            { value: 'restaurant', label: 'Restaurant', labelAr: 'مطعم' },
            { value: 'parking', label: 'Parking', labelAr: 'موقف سيارات' },
            { value: 'conference', label: 'Conference Rooms', labelAr: 'قاعات مؤتمرات' },
          ],
        },
        { key: 'floorsData', label: 'Floors Configuration', labelAr: 'إعداد الطوابق', type: ProfileFieldType.FLOORS_ARRAY, required: false, group: 'Floors', order: 5 },
        { key: 'city', label: 'City', labelAr: 'المدينة', type: ProfileFieldType.SELECT, required: false, group: 'Location', order: 6, options: SAUDI_CITIES },
      ],
      deviceLinkingConfig: { allowMultipleDevices: true, maxDevices: 1500 },
    },
    hierarchyConfig: { allowChildren: true, allowedChildTypes: ['floor', 'zone', 'room'], requireParent: false, maxDepth: 3 },
    mapConfig: { icon: 'hotel', iconColor: '#9C27B0', markerType: 'pin', showLabel: true },
    additionalInfo: { category: 'hospitality', icon: 'hotel', color: '#9C27B0' },
  },

  // ── 7. Factory ────────────────────────────────────────────────────────────
  {
    name: 'Factory',
    description: 'Manufacturing plant with production lines and shifts.',
    type: AssetProfileType.FACTORY,
    schema: {
      fields: [
        { key: 'totalArea', label: 'Total Area', labelAr: 'المساحة الإجمالية', type: ProfileFieldType.NUMBER, required: true, min: 1, unit: 'm²', group: 'Plant Info', order: 1 },
        { key: 'productionLines', label: 'Production Lines', labelAr: 'خطوط الإنتاج', type: ProfileFieldType.NUMBER, required: false, min: 0, group: 'Production', order: 2 },
        { key: 'shifts', label: 'Number of Shifts', labelAr: 'عدد الورديات', type: ProfileFieldType.NUMBER, required: false, min: 1, max: 4, group: 'Production', order: 3 },
        {
          key: 'industryType', label: 'Industry Type', labelAr: 'نوع الصناعة', type: ProfileFieldType.SELECT, required: false, group: 'Plant Info', order: 4,
          options: [
            { value: 'food_beverage', label: 'Food & Beverage', labelAr: 'أغذية ومشروبات' },
            { value: 'automotive', label: 'Automotive', labelAr: 'سيارات' },
            { value: 'electronics', label: 'Electronics', labelAr: 'إلكترونيات' },
            { value: 'pharmaceutical', label: 'Pharmaceutical', labelAr: 'أدوية' },
            { value: 'textile', label: 'Textile', labelAr: 'نسيج' },
            { value: 'chemical', label: 'Chemical', labelAr: 'كيماويات' },
            { value: 'petrochemical', label: 'Petrochemical', labelAr: 'بتروكيماويات' },
            { value: 'other', label: 'Other', labelAr: 'أخرى' },
          ],
        },
        { key: 'hazardousMaterials', label: 'Handles Hazardous Materials', labelAr: 'يتعامل مع مواد خطرة', type: ProfileFieldType.BOOLEAN, required: false, group: 'Safety', order: 5, defaultValue: false },
        { key: 'safetyOfficer', label: 'Safety Officer', labelAr: 'مسؤول السلامة', type: ProfileFieldType.TEXT, required: false, group: 'Safety', order: 6 },
        { key: 'region', label: 'Region', labelAr: 'المنطقة', type: ProfileFieldType.SELECT, required: false, group: 'Location', order: 7, options: SAUDI_REGIONS },
      ],
      deviceLinkingConfig: { allowMultipleDevices: true, maxDevices: 2000 },
    },
    hierarchyConfig: { allowChildren: true, allowedChildTypes: ['zone', 'room'], requireParent: false, maxDepth: 2 },
    mapConfig: { icon: 'precision_manufacturing', iconColor: '#FF6F00', markerType: 'pin', showLabel: true },
    additionalInfo: { category: 'industrial', icon: 'precision_manufacturing', color: '#FF6F00' },
  },

  // ── 8. Shop / Retail ──────────────────────────────────────────────────────
  // Name is kept as "Shop/Retail" so the rows seeded before this change are
  // matched and updated in place rather than duplicated.
  {
    name: 'Shop/Retail',
    description: 'Retail store or shop floor with departments and checkouts.',
    type: AssetProfileType.SHOP,
    schema: {
      fields: [
        { key: 'totalArea', label: 'Total Area', labelAr: 'المساحة الإجمالية', type: ProfileFieldType.NUMBER, required: true, min: 1, unit: 'm²', group: 'Store Info', order: 1 },
        { key: 'departments', label: 'Number of Departments', labelAr: 'عدد الأقسام', type: ProfileFieldType.NUMBER, required: false, min: 0, group: 'Store Info', order: 2 },
        { key: 'checkoutCounters', label: 'Checkout Counters', labelAr: 'نقاط البيع', type: ProfileFieldType.NUMBER, required: false, min: 0, group: 'Store Info', order: 3 },
        { key: 'storageArea', label: 'Storage Area', labelAr: 'مساحة التخزين', type: ProfileFieldType.NUMBER, required: false, min: 0, unit: 'm²', group: 'Store Info', order: 4 },
        {
          key: 'retailType', label: 'Retail Type', labelAr: 'نوع المتجر', type: ProfileFieldType.SELECT, required: false, group: 'Store Info', order: 5,
          options: [
            { value: 'supermarket', label: 'Supermarket', labelAr: 'سوبر ماركت' },
            { value: 'hypermarket', label: 'Hypermarket', labelAr: 'هايبر ماركت' },
            { value: 'convenience', label: 'Convenience Store', labelAr: 'بقالة' },
            { value: 'fashion', label: 'Fashion', labelAr: 'أزياء' },
            { value: 'electronics', label: 'Electronics', labelAr: 'إلكترونيات' },
            { value: 'pharmacy', label: 'Pharmacy', labelAr: 'صيدلية' },
            { value: 'restaurant', label: 'Restaurant / Cafe', labelAr: 'مطعم / مقهى' },
            { value: 'other', label: 'Other', labelAr: 'أخرى' },
          ],
        },
        { key: 'openingHours', label: 'Opening Hours', labelAr: 'ساعات العمل', type: ProfileFieldType.TEXT, required: false, group: 'Operations', order: 6, placeholder: 'e.g. 08:00 - 23:00', placeholderAr: 'مثل: ٠٨:٠٠ - ٢٣:٠٠' },
        { key: 'city', label: 'City', labelAr: 'المدينة', type: ProfileFieldType.SELECT, required: false, group: 'Location', order: 7, options: SAUDI_CITIES },
      ],
      deviceLinkingConfig: { allowMultipleDevices: true, maxDevices: 300 },
    },
    hierarchyConfig: { allowChildren: true, allowedChildTypes: ['zone', 'room'], requireParent: false, maxDepth: 2 },
    mapConfig: { icon: 'storefront', iconColor: '#FF9800', markerType: 'pin', showLabel: true },
    additionalInfo: { category: 'retail', icon: 'storefront', color: '#FF9800' },
  },

  // ── 9. Custom ─────────────────────────────────────────────────────────────
  {
    name: 'Custom',
    description:
      'Blank profile — define your own fields. Used as the tenant default.',
    type: AssetProfileType.CUSTOM,
    schema: {
      fields: [],
      deviceLinkingConfig: { allowMultipleDevices: true },
    },
    default: true,
    hierarchyConfig: { allowChildren: true, requireParent: false },
    mapConfig: { icon: 'category', iconColor: '#607D8B', markerType: 'pin', showLabel: true },
    additionalInfo: { category: 'custom', icon: 'category', color: '#607D8B' },
  },
];

@Injectable()
export class AssetProfileSeeder implements ISeeder {
  private readonly logger = new Logger(AssetProfileSeeder.name);

  constructor(
    @InjectRepository(AssetProfile)
    private readonly assetProfileRepository: Repository<AssetProfile>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('Seeding asset profiles...');

    const tenants = await this.tenantRepository.find();

    if (tenants.length === 0) {
      this.logger.warn('No tenants found. Please seed tenants first.');
      return;
    }

    let created = 0;
    let updated = 0;

    for (const tenant of tenants) {
      for (const definition of PROFILE_DEFINITIONS) {
        const existing = await this.assetProfileRepository.findOne({
          where: { name: definition.name, tenantId: tenant.id },
        });

        if (existing) {
          // Backfill the new columns on databases seeded before they existed,
          // and rewrite `options: string[]` into the bilingual option shape.
          existing.type = definition.type;
          existing.schema = definition.schema;
          existing.description = definition.description;
          if (definition.hierarchyConfig)
            existing.hierarchyConfig = definition.hierarchyConfig;
          if (definition.mapConfig) existing.mapConfig = definition.mapConfig;
          if (definition.additionalInfo)
            existing.additionalInfo = definition.additionalInfo;
          await this.assetProfileRepository.save(existing);
          updated++;
          continue;
        }

        const profile = this.assetProfileRepository.create({
          tenantId: tenant.id,
          name: definition.name,
          description: definition.description,
          type: definition.type,
          schema: definition.schema,
          default: definition.default ?? false,
          hierarchyConfig: definition.hierarchyConfig,
          mapConfig: definition.mapConfig,
          additionalInfo: definition.additionalInfo,
          locationConfig: {
            required: false,
            requireCoordinates: false,
            allowManualEntry: true,
            defaultZoom: 15,
          },
          deviceConfig: { allowDevices: true },
        });

        await this.assetProfileRepository.save(profile);
        created++;
      }
    }

    this.logger.log(
      `Asset profile seeding complete - ${created} created, ${updated} updated ` +
        `(${PROFILE_DEFINITIONS.length} profiles x ${tenants.length} tenant(s)).`,
    );
  }
}
