/*
 * This module was originally taken from the K8dash project before modifications.
 *
 * K8dash is licensed under Apache License 2.0.
 *
 * Copyright © 2020 Eric Herbrandson
 * Copyright © 2020 Kinvolk GmbH
 */

import { OpPatch } from 'json-patch';
import _ from 'lodash';
import { decodeToken } from 'react-jwt';
import helpers, { getHeadlampAPIHeaders, getSessionId, isDebugVerbose } from '../../helpers';
import store from '../../redux/stores/store';
import { getToken, logout, setToken } from '../auth';
import { getCluster } from '../util';
import { ResourceClasses } from '.';
import { KubeMetadata, KubeMetrics, KubeObjectInterface } from './cluster';
import { KubeToken } from './token';

// Uncomment the following lines to enable verbose debug logging in this module.
// import { debugVerbose } from '../../helpers';
// debugVerbose('k8s/apiProxy');

const BASE_HTTP_URL = helpers.getAppUrl();
const BASE_WS_URL = BASE_HTTP_URL.replace('http', 'ws');
const CLUSTERS_PREFIX = 'clusters';
const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };
const DEFAULT_TIMEOUT = 2 * 60 * 1000; // ms
const MIN_LIFESPAN_FOR_TOKEN_REFRESH = 10; // sec

let isTokenRefreshInProgress = false;

export interface RequestParams {
  timeout?: number; // ms
  isJSON?: boolean;
  [prop: string]: any;
}

export interface ClusterRequest {
  /** The name of the cluster (has to be unique, or it will override an existing cluster) */
  name?: string;
  /** The cluster URL */
  server?: string;
  /** Whether the server's certificate should not be checked for validity */
  insecureTLSVerify?: boolean;
  /** The certificate authority data */
  certificateAuthorityData?: string;
  /** KubeConfig (base64 encoded)*/
  kubeconfig?: string;
}

export interface QueryParameters {
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
  [prop: string]: any;
}

//refreshToken checks if the token is about to expire and refreshes it if so.
async function refreshToken(token: string | null) {
  if (!token || isTokenRefreshInProgress) {
    return;
  }
  // decode token
  const decodedToken: any = decodeToken(token);

  // return if the token doesn't have an expiry time
  if (!decodedToken.exp) {
    return;
  }
  // convert expiry seconds to date object
  const expiry = decodedToken.exp;
  const now = new Date().valueOf();
  const expDate = new Date(0);
  expDate.setUTCSeconds(expiry);

  // calculate time to expiry in seconds
  const diff = (expDate.valueOf() - now) / 1000;
  // If the token is not about to expire return
  // comparing the time to expiry with the minimum lifespan for a token both in seconds
  if (diff > MIN_LIFESPAN_FOR_TOKEN_REFRESH) {
    return;
  }
  const namespace =
    (decodedToken && decodedToken['kubernetes.io'] && decodedToken['kubernetes.io']['namespace']) ||
    '';
  const serviceAccountName =
    (decodedToken &&
      decodedToken['kubernetes.io'] &&
      decodedToken['kubernetes.io']['serviceaccount'] &&
      decodedToken['kubernetes.io']['serviceaccount']['name']) ||
    {};
  const cluster = getCluster();
  if (!cluster || namespace === '' || serviceAccountName === '') {
    return;
  }

  if (isDebugVerbose('k8s/apiProxy@refreshToken')) {
    console.debug('k8s/apiProxy@refreshToken', 'Refreshing token');
  }

  isTokenRefreshInProgress = true;

  let tokenUrl = combinePath(BASE_HTTP_URL, `/${CLUSTERS_PREFIX}/${cluster}`);
  tokenUrl = combinePath(
    tokenUrl,
    `api/v1/namespaces/${namespace}/serviceaccounts/${serviceAccountName}/token`
  );
  const tokenData = {
    kind: 'TokenRequest',
    apiVersion: 'authentication.k8s.io/v1',
    metadata: { creationTimestamp: null },
    spec: { expirationSeconds: 86400 },
  };

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
      body: JSON.stringify(tokenData),
    });

    if (response.status === 201) {
      const token: KubeToken = await response.json();
      setToken(cluster, token.status.token);
    }

    isTokenRefreshInProgress = false;
  } catch (err) {
    console.error('Error refreshing token', err);
    isTokenRefreshInProgress = false;
  }
}

// getClusterAuthType returns the auth type of the cluster.
function getClusterAuthType(cluster: string): string {
  const state = store.getState();
  const authType: string = state.config?.clusters?.[cluster]?.['auth_type'] || '';
  return authType;
}

/**
 * Sends a request to the backend. If the useCluster parameter is true (which it is, by default), it will be
 * treated as a request to the Kubernetes server of the currently defined (in the URL) cluster.
 *
 * @param path - The path to the API endpoint.
 * @param params - Optional parameters for the request.
 * @param autoLogoutOnAuthError - Whether to automatically log out the user if there is an authentication error.
 * @param useCluster - Whether to use the current cluster for the request.
 * @param queryParams - Optional query parameters for the request.
 *
 * @returns A Promise that resolves to the JSON response from the API server.
 * @throws An ApiError if the response status is not ok.
 */
export async function request(
  path: string,
  params: RequestParams = {},
  autoLogoutOnAuthError: boolean = true,
  useCluster: boolean = true,
  queryParams?: QueryParameters
) {
  // @todo: This is a temporary way of getting the current cluster. We should improve it later.
  const cluster = (useCluster && getCluster()) || '';

  if (isDebugVerbose('k8s/apiProxy@request')) {
    console.debug('k8s/apiProxy@request', { path, params, useCluster, queryParams });
  }

  return clusterRequest(path, { cluster, autoLogoutOnAuthError, ...params }, queryParams);
}

/**
 * Sends a request to the backend. If the cluster is required in the params parameter, it will
 * be used as a request to the respective Kubernetes server.
 *
 * @param path - The path to the API endpoint.
 * @param params - Optional parameters for the request.
 * @param queryParams - Optional query parameters for the request.
 *
 * @returns A Promise that resolves to the JSON response from the API server.
 * @throws An ApiError if the response status is not ok.
 */
export async function clusterRequest(
  path: string,
  params: RequestParams = {},
  queryParams?: QueryParameters
) {
  interface RequestHeaders {
    Authorization?: string;
    cluster?: string;
    autoLogoutOnAuthError?: boolean;
    [otherHeader: string]: any;
  }

  const {
    timeout = DEFAULT_TIMEOUT,
    cluster: paramsCluster,
    autoLogoutOnAuthError = true,
    isJSON = true,
    ...otherParams
  } = params;
  const opts: { headers: RequestHeaders } = Object.assign({ headers: {} }, otherParams);
  const cluster = paramsCluster || '';

  let fullPath = path;
  if (cluster) {
    const token = getToken(cluster);

    // Refresh service account token only if the cluster auth type is not OIDC
    if (getClusterAuthType(cluster) !== 'oidc') {
      await refreshToken(token);
    }

    if (!!token) {
      opts.headers.Authorization = `Bearer ${token}`;
    }

    fullPath = combinePath(`/${CLUSTERS_PREFIX}/${cluster}`, path);
  }

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  let url = combinePath(BASE_HTTP_URL, fullPath);
  url += asQuery(queryParams);
  const requestData = { signal: controller.signal, ...opts };
  let response: Response = new Response(undefined, { status: 502, statusText: 'Unreachable' });
  try {
    response = await fetch(url, requestData);
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        response = new Response(undefined, { status: 408, statusText: 'Request timed-out' });
      }
    }
  } finally {
    clearTimeout(id);
  }

  // The backend signals through this header that it wants a reload.
  // See plugins.go
  const headerVal = response.headers.get('X-Reload');
  if (headerVal && headerVal.indexOf('reload') !== -1) {
    window.location.reload();
  }

  if (!response.ok) {
    const { status, statusText } = response;
    if (autoLogoutOnAuthError && status === 401 && opts.headers.Authorization) {
      console.error('Logging out due to auth error', { status, statusText, path });
      logout();
    }

    let message = statusText;
    try {
      if (isJSON) {
        const json = await response.json();
        message += ` - ${json.message}`;
      }
    } catch (err) {
      console.error(
        'Unable to parse error json at url:',
        url,
        { err },
        'with request data:',
        requestData
      );
    }

    const error = new Error(message) as ApiError;
    error.status = status;
    return Promise.reject(error);
  }

  if (!isJSON) {
    return Promise.resolve(response);
  }

  return response.json();
}

export type StreamResultsCb = (...args: any[]) => void;
export type StreamErrCb = (err: Error & { status?: number }, cancelStreamFunc?: () => void) => void;

type ApiFactoryReturn = ReturnType<typeof apiFactory> | ReturnType<typeof apiFactoryWithNamespace>;

async function repeatStreamFunc(
  apiEndpoints: ApiFactoryReturn[],
  funcName: keyof ApiFactoryReturn,
  errCb: StreamErrCb,
  ...args: any[]
) {
  let isCancelled = false;
  let streamCancel = () => {};

  if (isDebugVerbose('k8s/apiProxy@repeatStreamFunc')) {
    console.debug('k8s/apiProxy@repeatStreamFunc', { apiEndpoints, funcName, args });
  }

  function runStreamFunc(
    endpointIndex: number,
    funcName: string,
    errCb: StreamErrCb,
    ...args: any[]
  ) {
    const endpoint = apiEndpoints[endpointIndex];
    return endpoint[funcName as keyof ApiFactoryReturn](...args, errCb);
  }

  let endpointIndex = 0;
  const cancel: StreamErrCb = async (err, cancelStream) => {
    if (isCancelled) {
      return;
    }
    if (err.status === 404 && endpointIndex < apiEndpoints.length) {
      // Cancel current stream
      if (cancelStream) {
        cancelStream();
      }

      streamCancel = await runStreamFunc(endpointIndex++, funcName, cancel, ...args);
    } else if (!!errCb) {
      errCb(err, streamCancel);
    }
  };

  streamCancel = await runStreamFunc(endpointIndex++, funcName, cancel, ...args);

  return () => {
    isCancelled = true;
    streamCancel();
  };
}

function repeatFactoryMethod(apiEndpoints: ApiFactoryReturn[], funcName: keyof ApiFactoryReturn) {
  return async (...args: Parameters<ApiFactoryReturn[typeof funcName]>) => {
    for (let i = 0; i < apiEndpoints.length; i++) {
      try {
        const endpoint = apiEndpoints[i];
        return await endpoint[funcName](...args);
      } catch (err) {
        // If the error is 404 and we still have other endpoints, then try the next one
        if ((err as ApiError).status === 404 && i !== apiEndpoints.length - 1) {
          continue;
        }

        throw err;
      }
    }
  };
}

export function apiFactory(
  ...args: Parameters<typeof singleApiFactory> | Parameters<typeof multipleApiFactory>
) {
  if (isDebugVerbose('k8s/apiProxy@apiFactory')) {
    console.debug('k8s/apiProxy@apiFactory', { args });
  }

  if (args[0] instanceof Array) {
    return multipleApiFactory(...(args as Parameters<typeof multipleApiFactory>));
  }

  return singleApiFactory(...(args as Parameters<typeof singleApiFactory>));
}

function multipleApiFactory(
  ...args: Parameters<typeof singleApiFactory>[]
): ReturnType<typeof singleApiFactory> {
  if (isDebugVerbose('k8s/apiProxy@multipleApiFactory')) {
    console.debug('k8s/apiProxy@multipleApiFactory', { args });
  }

  const apiEndpoints: ReturnType<typeof singleApiFactory>[] = args.map(apiArgs =>
    singleApiFactory(...apiArgs)
  );

  return {
    list: (cb: StreamResultsCb, errCb: StreamErrCb) =>
      repeatStreamFunc(apiEndpoints, 'list', errCb, cb),
    get: (name: string, cb: StreamResultsCb, errCb: StreamErrCb) =>
      repeatStreamFunc(apiEndpoints, 'get', errCb, name, cb),
    post: repeatFactoryMethod(apiEndpoints, 'post'),
    patch: repeatFactoryMethod(apiEndpoints, 'patch'),
    put: repeatFactoryMethod(apiEndpoints, 'put'),
    delete: repeatFactoryMethod(apiEndpoints, 'delete'),
    isNamespaced: false,
  };
}

function singleApiFactory(group: string, version: string, resource: string) {
  if (isDebugVerbose('k8s/apiProxy@singleApiFactory')) {
    console.debug('k8s/apiProxy@singleApiFactory', { group, version, resource });
  }

  const apiRoot = getApiRoot(group, version);
  const url = `${apiRoot}/${resource}`;
  return {
    list: (cb: StreamResultsCb, errCb: StreamErrCb, queryParams?: QueryParameters) => {
      if (isDebugVerbose('k8s/apiProxy@singleApiFactory list')) {
        console.debug('k8s/apiProxy@singleApiFactory list', { queryParams });
      }

      return streamResults(url, cb, errCb, queryParams);
    },
    get: (name: string, cb: StreamResultsCb, errCb: StreamErrCb, queryParams?: QueryParameters) =>
      streamResult(url, name, cb, errCb, queryParams),
    post: (body: KubeObjectInterface, queryParams?: QueryParameters) =>
      post(url + asQuery(queryParams), body),
    put: (body: KubeObjectInterface, queryParams?: QueryParameters) =>
      put(`${url}/${body.metadata.name}` + asQuery(queryParams), body),
    patch: (body: OpPatch[], name: string, queryParams?: QueryParameters) =>
      patch(`${url}/${name}` + asQuery({ ...queryParams, ...{ pretty: 'true' } }), body),
    delete: (name: string, queryParams?: QueryParameters) =>
      remove(`${url}/${name}` + asQuery(queryParams)),
    isNamespaced: false,
  };
}

export function apiFactoryWithNamespace(
  ...args:
    | Parameters<typeof simpleApiFactoryWithNamespace>
    | Parameters<typeof multipleApiFactoryWithNamespace>
) {
  if (args[0] instanceof Array) {
    return multipleApiFactoryWithNamespace(
      ...(args as Parameters<typeof multipleApiFactoryWithNamespace>)
    );
  }

  return simpleApiFactoryWithNamespace(
    ...(args as Parameters<typeof simpleApiFactoryWithNamespace>)
  );
}

function multipleApiFactoryWithNamespace(
  ...args: Parameters<typeof simpleApiFactoryWithNamespace>[]
): ReturnType<typeof simpleApiFactoryWithNamespace> {
  const apiEndpoints: ReturnType<typeof simpleApiFactoryWithNamespace>[] = args.map(apiArgs =>
    simpleApiFactoryWithNamespace(...apiArgs)
  );

  return {
    list: (namespace: string, cb: StreamResultsCb, errCb: StreamErrCb) =>
      repeatStreamFunc(apiEndpoints, 'list', errCb, namespace, cb),
    get: (namespace: string, name: string, cb: StreamResultsCb, errCb: StreamErrCb) =>
      repeatStreamFunc(apiEndpoints, 'get', errCb, namespace, name, cb),
    post: repeatFactoryMethod(apiEndpoints, 'post'),
    patch: repeatFactoryMethod(apiEndpoints, 'patch'),
    put: repeatFactoryMethod(apiEndpoints, 'put'),
    delete: repeatFactoryMethod(apiEndpoints, 'delete'),
    isNamespaced: true,
  };
}

function simpleApiFactoryWithNamespace(
  group: string,
  version: string,
  resource: string,
  includeScale: boolean = false
) {
  if (isDebugVerbose('k8s/apiProxy@simpleApiFactoryWithNamespace')) {
    console.debug('k8s/apiProxy@simpleApiFactoryWithNamespace', {
      group,
      version,
      resource,
      includeScale,
    });
  }

  const apiRoot = getApiRoot(group, version);
  const results: {
    scale?: ReturnType<typeof apiScaleFactory>;
    [other: string]: any;
  } = {
    list: (
      namespace: string,
      cb: StreamResultsCb,
      errCb: StreamErrCb,
      queryParams?: QueryParameters
    ) => {
      if (isDebugVerbose('k8s/apiProxy@simpleApiFactoryWithNamespace list')) {
        console.debug('k8s/apiProxy@simpleApiFactoryWithNamespace list', { queryParams });
      }

      return streamResults(url(namespace), cb, errCb, queryParams);
    },
    get: (
      namespace: string,
      name: string,
      cb: StreamResultsCb,
      errCb: StreamErrCb,
      queryParams?: QueryParameters
    ) => streamResult(url(namespace), name, cb, errCb, queryParams),
    post: (body: KubeObjectInterface, queryParams?: QueryParameters) =>
      post(url(body.metadata.namespace!) + asQuery(queryParams), body),
    patch: (body: OpPatch[], namespace: string, name: string, queryParams?: QueryParameters) =>
      patch(`${url(namespace)}/${name}` + asQuery({ ...queryParams, ...{ pretty: 'true' } }), body),
    put: (body: KubeObjectInterface, queryParams?: QueryParameters) =>
      put(`${url(body.metadata.namespace!)}/${body.metadata.name}` + asQuery(queryParams), body),
    delete: (namespace: string, name: string, queryParams?: QueryParameters) =>
      remove(`${url(namespace)}/${name}` + asQuery(queryParams)),
    isNamespaced: true,
  };

  if (includeScale) {
    results.scale = apiScaleFactory(apiRoot, resource);
  }

  return results;

  function url(namespace: string) {
    return namespace ? `${apiRoot}/namespaces/${namespace}/${resource}` : `${apiRoot}/${resource}`;
  }
}

function asQuery(queryParams?: QueryParameters): string {
  return !!queryParams && !!Object.keys(queryParams).length
    ? '?' + new URLSearchParams(queryParams).toString()
    : '';
}

function resourceDefToApiFactory(resourceDef: KubeObjectInterface): ApiFactoryReturn {
  if (isDebugVerbose('k8s/apiProxy@resourceDefToApiFactory')) {
    console.debug('k8s/apiProxy@resourceDefToApiFactory', { resourceDef });
  }

  if (!resourceDef.kind) {
    throw new Error(`Cannot handle unknown resource kind: ${resourceDef.kind}`);
  }

  if (!resourceDef.apiVersion) {
    throw new Error(`Definition has no apiVersion`);
  }

  let factoryFunc: typeof apiFactory | typeof apiFactoryWithNamespace = apiFactory;
  if (!!resourceDef.metadata?.namespace) {
    factoryFunc = apiFactoryWithNamespace;
  }

  let [apiGroup, apiVersion] = resourceDef.apiVersion.split('/');

  // There may not be an API group [1], which means that the apiGroup variable will
  // actually hold the apiVersion, so we switch them.
  // [1] https://kubernetes.io/docs/reference/using-api/#api-groups
  if (!!apiGroup && !apiVersion) {
    apiVersion = apiGroup;
    apiGroup = '';
  }

  if (!apiVersion) {
    throw new Error(`apiVersion has no version string: ${resourceDef.apiVersion}`);
  }

  // Try to use a known resource class to get the plural from, otherwise fall back to
  // generating a plural from the kind (which is very naive).
  const knownResource = ResourceClasses[resourceDef.kind];
  const resourcePlural = knownResource?.pluralName || resourceDef.kind.toLowerCase() + 's';

  return factoryFunc(apiGroup, apiVersion, resourcePlural);
}

function getApiRoot(group: string, version: string) {
  return group ? `/apis/${group}/${version}` : `api/${version}`;
}

function apiScaleFactory(apiRoot: string, resource: string) {
  return {
    get: (namespace: string, name: string) => request(url(namespace, name)),
    put: (body: { metadata: KubeMetadata; spec: { replicas: number } }) =>
      put(url(body.metadata.namespace!, body.metadata.name), body),
  };

  function url(namespace: string, name: string) {
    return `${apiRoot}/namespaces/${namespace}/${resource}/${name}/scale`;
  }
}

export function post(
  url: string,
  json: JSON | object | KubeObjectInterface,
  autoLogoutOnAuthError = true,
  requestOptions = {}
) {
  const body = JSON.stringify(json);
  const opts = { method: 'POST', body, headers: JSON_HEADERS, ...requestOptions };
  return request(url, opts, autoLogoutOnAuthError);
}

export function patch(url: string, json: any, autoLogoutOnAuthError = true, requestOptions = {}) {
  const body = JSON.stringify(json);
  const opts = {
    method: 'PATCH',
    body,
    headers: { ...JSON_HEADERS, 'Content-Type': 'application/json-patch+json' },
    ...requestOptions,
  };
  return request(url, opts, autoLogoutOnAuthError);
}

export function put(
  url: string,
  json: Partial<KubeObjectInterface>,
  autoLogoutOnAuthError = true,
  requestOptions = {}
) {
  const body = JSON.stringify(json);
  const opts = { method: 'PUT', body, headers: JSON_HEADERS, ...requestOptions };
  return request(url, opts, autoLogoutOnAuthError);
}

export function remove(url: string, requestOptions = {}) {
  const opts = { method: 'DELETE', headers: JSON_HEADERS, ...requestOptions };
  return request(url, opts);
}

/**
 * Streams the results of a Kubernetes API request.
 *
 * @param url - The URL of the Kubernetes API endpoint.
 * @param name - The name of the Kubernetes API resource.
 * @param cb - The callback function to execute when the stream receives data.
 * @param errCb - The callback function to execute when an error occurs.
 * @param queryParams - The query parameters to include in the API request.
 *
 * @returns A function to cancel the stream.
 */
export async function streamResult(
  url: string,
  name: string,
  cb: StreamResultsCb,
  errCb: StreamErrCb,
  queryParams?: QueryParameters
) {
  let isCancelled = false;
  let socket: ReturnType<typeof stream>;

  if (isDebugVerbose('k8s/apiProxy@streamResult')) {
    console.debug('k8s/apiProxy@streamResult', { url, name, queryParams });
  }

  run();

  return cancel;

  async function run() {
    try {
      const item = await request(`${url}/${name}` + asQuery(queryParams));

      if (isCancelled) return;

      if (isDebugVerbose('k8s/apiProxy@streamResult run cb(item)')) {
        console.debug('k8s/apiProxy@streamResult run cb(item)', { item });
      }

      cb(item);

      const watchUrl =
        url +
        asQuery({ ...queryParams, ...{ watch: '1', fieldSelector: `metadata.name=${name}` } });

      socket = stream(watchUrl, x => cb(x.object), { isJson: true });
    } catch (err) {
      console.error('Error in api request', { err, url });
      // @todo: sometimes errCb is {}, the typing for apiProxy needs improving.
      //        See https://github.com/kinvolk/headlamp/pull/833
      if (errCb && typeof errCb === 'function') errCb(err as ApiError, cancel);
    }
  }

  function cancel() {
    if (isCancelled) return;
    isCancelled = true;

    if (socket) socket.cancel();
  }
}

/**
 * Streams the results of a Kubernetes API request.
 *
 * @param url - The URL of the Kubernetes API endpoint.
 * @param cb - The callback function to execute when the stream receives data.
 * @param errCb - The callback function to execute when an error occurs.
 * @param queryParams - The query parameters to include in the API request.
 *
 * @returns A function to cancel the stream.
 */
export async function streamResults(
  url: string,
  cb: StreamResultsCb,
  errCb: StreamErrCb,
  queryParams: QueryParameters | undefined
) {
  const results: {
    [uid: string]: KubeObjectInterface;
  } = {};
  let isCancelled = false;
  let socket: ReturnType<typeof stream>;

  if (isDebugVerbose('k8s/apiProxy@streamResults')) {
    console.debug('k8s/apiProxy@streamResults', { url, queryParams });
  }

  run();

  return cancel;

  async function run() {
    try {
      const { kind, items, metadata } = await request(url + asQuery(queryParams));

      if (isCancelled) return;

      add(items, kind);

      const watchUrl =
        url +
        asQuery({ ...queryParams, ...{ watch: '1', resourceVersion: metadata.resourceVersion } });
      socket = stream(watchUrl, update, { isJson: true });
    } catch (err) {
      console.error('Error in api request', { err, url });
      if (errCb && typeof errCb === 'function') {
        errCb(err as ApiError, cancel);
      }
    }
  }

  function cancel() {
    if (isCancelled) return;
    isCancelled = true;

    if (socket) socket.cancel();
  }

  function add(items: KubeObjectInterface[], kind: string) {
    const fixedKind = kind.slice(0, -4); // Trim off the word "List" from the end of the string
    for (const item of items) {
      item.kind = fixedKind;
      results[item.metadata.uid] = item;
    }

    push();
  }

  function update({
    type,
    object,
  }: {
    type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR';
    object: KubeObjectInterface;
  }) {
    object.actionType = type; // eslint-disable-line no-param-reassign

    switch (type) {
      case 'ADDED':
        results[object.metadata.uid] = object;
        break;
      case 'MODIFIED': {
        const existing = results[object.metadata.uid];

        if (existing) {
          if (!existing.metadata.resourceVersion || !object.metadata.resourceVersion) {
            console.error('Missing resourceVersion in object', object);
            break;
          }
          const currentVersion = parseInt(existing.metadata.resourceVersion, 10);
          const newVersion = parseInt(object.metadata.resourceVersion, 10);
          if (currentVersion < newVersion) {
            Object.assign(existing, object);
          }
        } else {
          results[object.metadata.uid] = object;
        }

        break;
      }
      case 'DELETED':
        delete results[object.metadata.uid];
        break;
      case 'ERROR':
        console.error('Error in update', { type, object });
        break;
      default:
        console.error('Unknown update type', type);
    }

    push();
  }

  function push() {
    const values = Object.values(results);
    if (isDebugVerbose('k8s/apiProxy@push cb(values)')) {
      console.debug('k8s/apiProxy@push cb(values)', { values });
    }
    cb(values);
  }
}

/**
 * Configure a stream with... StreamArgs.
 */
export interface StreamArgs {
  /** Whether the stream is expected to receive JSON data. */
  isJson?: boolean;
  /** Additional WebSocket protocols to use when connecting. */
  additionalProtocols?: string[];
  /** A callback function to execute when the WebSocket connection is established. */
  connectCb?: () => void;
  /** Whether to attempt to reconnect the WebSocket connection if it fails. */
  reconnectOnFailure?: boolean;
  /** A callback function to execute when the WebSocket connection fails. */
  failCb?: () => void;
  tty?: boolean;
  stdin?: boolean;
  stdout?: boolean;
  stderr?: boolean;
}

/**
 * Establishes a WebSocket connection to the specified URL and streams the results
 * to the provided callback function.
 *
 * @param url - The URL to connect to.
 * @param cb - The callback function to receive the streamed results.
 * @param args - Additional arguments to configure the stream.
 *
 * @returns An object with two functions: `cancel`, which can be called to cancel
 * the stream, and `getSocket`, which returns the WebSocket object.
 */
export function stream(url: string, cb: StreamResultsCb, args: StreamArgs) {
  let connection: ReturnType<typeof connectStream>;
  let isCancelled = false;
  const { failCb } = args;
  // We only set reconnectOnFailure as true by default if the failCb has not been provided.
  const { isJson = false, additionalProtocols, connectCb, reconnectOnFailure = !failCb } = args;

  if (isDebugVerbose('k8s/apiProxy@stream')) {
    console.debug('k8s/apiProxy@stream', { url, args });
  }

  connect();

  return { cancel, getSocket };

  function getSocket() {
    return connection.socket;
  }

  function cancel() {
    if (connection) connection.close();
    isCancelled = true;
  }

  function connect() {
    if (connectCb) connectCb();
    connection = connectStream(url, cb, onFail, isJson, additionalProtocols);
  }

  function retryOnFail() {
    if (isCancelled) return;

    if (reconnectOnFailure) {
      if (isDebugVerbose('k8s/apiProxy@stream retryOnFail')) {
        console.debug('k8s/apiProxy@stream retryOnFail', 'Reconnecting in 3 seconds', { url });
      }

      setTimeout(connect, 3000);
    }
  }

  function onFail() {
    if (!!failCb) {
      failCb();
    }

    if (reconnectOnFailure) {
      retryOnFail();
    }
  }
}

function connectStream(
  path: string,
  cb: StreamResultsCb,
  onFail: () => void,
  isJson: boolean,
  additionalProtocols: string[] = []
) {
  let isClosing = false;

  // @todo: This is a temporary way of getting the current cluster. We should improve it later.
  const cluster = getCluster();
  const token = getToken(cluster || '');

  const protocols = ['base64.binary.k8s.io', ...additionalProtocols];
  if (token) {
    const encodedToken = btoa(token).replace(/=/g, '');
    protocols.push(`base64url.bearer.authorization.k8s.io.${encodedToken}`);
  }

  let fullPath = path;
  if (cluster) {
    fullPath = combinePath(`/${CLUSTERS_PREFIX}/${cluster}`, path);
  }

  const url = combinePath(BASE_WS_URL, fullPath);
  let socket: WebSocket | null = null;
  try {
    socket = new WebSocket(url, protocols);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
  } catch (error) {
    console.error(error);
  }

  return { close, socket };

  function close() {
    isClosing = true;
    if (!socket) {
      return;
    }
    socket.close();
  }

  function onMessage(body: MessageEvent) {
    if (isClosing) return;

    const item = isJson ? JSON.parse(body.data) : body.data;
    if (isDebugVerbose('k8s/apiProxy@connectStream onMessage cb(item)')) {
      console.debug('k8s/apiProxy@connectStream onMessage cb(item)', { item });
    }

    cb(item);
  }

  function onClose(...args: any[]) {
    if (isClosing) return;
    isClosing = true;
    if (!socket) {
      return;
    }

    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);

    console.warn('Socket closed unexpectedly', { path, args });
    onFail();
  }

  function onError(err: any) {
    console.error('Error in api stream', { err, path });
  }
}

function combinePath(base: string, path: string) {
  if (base.endsWith('/')) base = base.slice(0, -1); // eslint-disable-line no-param-reassign
  if (path.startsWith('/')) path = path.slice(1); // eslint-disable-line no-param-reassign
  return `${base}/${path}`;
}

export async function apply(body: KubeObjectInterface): Promise<JSON> {
  const bodyToApply = _.cloneDeep(body);
  // Check if the default namespace is needed. And we need to do this before
  // getting the apiEndpoint because it will affect the endpoint itself.
  const { namespace } = body.metadata;
  if (!namespace) {
    const knownResource = ResourceClasses[body.kind];
    if (knownResource?.isNamespaced) {
      let defaultNamespace = 'default';

      const cluster = getCluster();
      if (!!cluster) {
        const clusterSettings = helpers.loadClusterSettings(cluster);
        defaultNamespace = clusterSettings?.defaultNamespace || defaultNamespace;
      }

      bodyToApply.metadata.namespace = defaultNamespace;
    }
  }

  const apiEndpoint = resourceDefToApiFactory(bodyToApply);
  const resourceVersion = bodyToApply.metadata.resourceVersion;

  try {
    delete bodyToApply.metadata.resourceVersion;
    return await apiEndpoint.post(bodyToApply);
  } catch (err) {
    // Check to see if failed because the record already exists.
    // If the failure isn't a 409 (i.e. Confilct), just rethrow.
    if ((err as ApiError).status !== 409) throw err;

    // Preserve the resourceVersion if its an update request
    bodyToApply.metadata.resourceVersion = resourceVersion;
    // We had a conflict. Try a PUT
    return apiEndpoint.put(bodyToApply);
  }
}

export interface ApiError extends Error {
  status: number;
}

export async function metrics(
  url: string,
  onMetrics: (arg: KubeMetrics[]) => void,
  onError?: (err: ApiError) => void
) {
  const handel = setInterval(getMetrics, 10000);

  async function getMetrics() {
    try {
      const metric = await request(url);
      onMetrics(metric.items || metric);
    } catch (err) {
      if (isDebugVerbose('k8s/apiProxy@metrics')) {
        console.debug('k8s/apiProxy@metrics', { err, url });
      }

      if (onError) {
        onError(err as ApiError);
      }
    }
  }

  function cancel() {
    clearInterval(handel);
  }

  getMetrics();

  return cancel;
}

export async function testAuth() {
  const spec = { namespace: 'default' };
  return post('/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', { spec }, false, {
    timeout: 5 * 1000,
  });
}

export async function testClusterHealth() {
  return request('/healthz', { isJSON: false });
}

export async function setCluster(clusterReq: ClusterRequest) {
  return request(
    '/cluster',
    {
      method: 'POST',
      body: JSON.stringify(clusterReq),
      headers: { ...JSON_HEADERS, ...getSessionId(), ...getHeadlampAPIHeaders() },
    },
    false,
    false
  );
}

export async function deleteCluster(cluster: string) {
  return request(
    `/cluster/${cluster}`,
    { method: 'DELETE', headers: { ...getHeadlampAPIHeaders() } },
    false,
    false
  );
}

export function startPortForward(
  cluster: string,
  namespace: string,
  podname: string,
  containerPort: number | string,
  service: string,
  serviceNamespace: string,
  port?: string,
  id: string = ''
) {
  return fetch(`${helpers.getAppUrl()}portforward`, {
    method: 'POST',
    headers: new Headers({
      Authorization: `Bearer ${getToken(cluster)}`,
      ...JSON_HEADERS,
    }),
    body: JSON.stringify({
      cluster,
      namespace,
      pod: podname,
      service,
      targetPort: containerPort.toString(),
      serviceNamespace,
      id: id,
      port,
    }),
  }).then((response: Response) => {
    return response.json().then(data => {
      if (!response.ok) {
        throw new Error(data.message);
      }
      return data;
    });
  });
}

export function stopOrDeletePortForward(cluster: string, id: string, stopOrDelete: boolean = true) {
  return fetch(`${helpers.getAppUrl()}portforward`, {
    method: 'DELETE',
    body: JSON.stringify({
      cluster,
      id,
      stopOrDelete,
    }),
  }).then(response =>
    response.text().then(data => {
      if (!response.ok) {
        throw new Error('Error deleting port forward');
      }
      return data;
    })
  );
}

export function listPortForward(cluster: string) {
  return fetch(`${helpers.getAppUrl()}portforward/list?cluster=${cluster}`).then(response =>
    response.json()
  );
}

/**
 * Drain a node
 * @param cluster
 * @param nodeName
 * @returns {Promise<JSON>}
 * @throws {Error} if the request fails
 * @throws {Error} if the response is not ok
 *
 * This function is used to drain a node. It is used in the node detail page.
 * As draining a node is a long running process, we get the request received
 * message if the request is successful. And then we poll the drain node status endpoint
 * to get the status of the drain node process.
 */
export function drainNode(cluster: string, nodeName: string) {
  return fetch(`${helpers.getAppUrl()}drain-node`, {
    method: 'POST',
    headers: new Headers({
      Authorization: `Bearer ${getToken(cluster)}`,
      ...JSON_HEADERS,
    }),
    body: JSON.stringify({
      cluster,
      nodeName,
    }),
  }).then(response => {
    return response.json().then(data => {
      if (!response.ok) {
        throw new Error('Something went wrong');
      }
      return data;
    });
  });
}

/**
 * Get the status of the drain node process
 * @param cluster
 * @param nodeName
 * @returns {Promise<JSON>}
 * @throws {Error} if the request fails
 * @throws {Error} if the response is not ok
 *
 * This function is used to get the status of the drain node process. It is used in the node detail page.
 * As draining a node is a long running process, we poll this endpoint to get the status of the drain node process.
 */
export function drainNodeStatus(cluster: string, nodeName: string) {
  return fetch(`${helpers.getAppUrl()}drain-node-status?cluster=${cluster}&nodeName=${nodeName}`, {
    method: 'GET',
    headers: new Headers({
      Authorization: `Bearer ${getToken(cluster)}`,
      ...JSON_HEADERS,
    }),
  }).then(response => {
    return response.json().then(data => {
      if (!response.ok) {
        throw new Error('Something went wrong');
      }
      return data;
    });
  });
}
