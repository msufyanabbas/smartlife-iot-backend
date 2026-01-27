export enum DeviceTransportType {
  MQTT = 'mqtt',
  HTTP = 'http',
  COAP = 'coap',
  LWM2M = 'lwm2m',
  SNMP = 'snmp',
}

export enum DeviceProvisionType {
  DISABLED = 'disabled',
  ALLOW_CREATE_NEW = 'allow_create_new',
  CHECK_PRE_PROVISIONED = 'check_pre_provisioned',
}