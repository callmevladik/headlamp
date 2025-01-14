import { KubeObject, KubeObjectInterface } from './KubeObject';

export interface LeaseSpec {
  holderIdentity: string;
  leaseDurationSeconds: number;
  leaseTransitions: number;
  renewTime: string;
}

export interface KubeLease extends KubeObjectInterface {
  spec: LeaseSpec;
}

export class Lease extends KubeObject<KubeLease> {
  static kind = 'Lease';
  static apiName = 'leases';
  static apiVersion = 'coordination.k8s.io/v1';
  static isNamespaced = true;

  get spec() {
    return this.jsonData.spec;
  }
}
