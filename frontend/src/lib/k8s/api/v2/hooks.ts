import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getCluster } from '../../../cluster';
import { ApiError, QueryParameters } from '../../apiProxy';
import { KubeObject, KubeObjectInterface } from '../../KubeObject';
import { clusterFetch } from './fetch';
import { KubeList, KubeListUpdateEvent } from './KubeList';
import { KubeObjectEndpoint } from './KubeObjectEndpoint';
import { makeUrl } from './makeUrl';
import { useWebSocket } from './webSocket';

export type QueryStatus = 'pending' | 'success' | 'error';

export interface QueryResponse<DataType, ErrorType> {
  /**
   * The last successfully resolved data for the query.
   */
  data: DataType | null;
  /**
   * The error object for the query, if an error was thrown.
   * - Defaults to `null`.
   */
  error: ErrorType | null;
  /**
   * A derived boolean from the `status` variable, provided for convenience.
   * - `true` if the query attempt resulted in an error.
   */
  isError: boolean;
  /**
   * Is `true` whenever the first fetch for a query is in-flight.
   */
  isLoading: boolean;
  /**
   * Is `true` whenever the query is executing, which includes initial fetch as well as background refetch.
   */
  isFetching: boolean;
  /**
   * A derived boolean from the `status` variable, provided for convenience.
   * - `true` if the query has received a response with no errors and is ready to display its data.
   */
  isSuccess: boolean;
  /**
   * The status of the query.
   * - Will be:
   *   - `pending` if there's no cached data and no query attempt was finished yet.
   *   - `error` if the query attempt resulted in an error.
   *   - `success` if the query has received a response with no errors and is ready to display its data.
   */
  status: QueryStatus;
}

/**
 * Query response containing KubeList with added items field for convenience
 */
export interface QueryListResponse<DataType, ItemType, ErrorType>
  extends QueryResponse<DataType, ErrorType> {
  items: Array<ItemType> | null;
  /**
   * Results from individual clusters. Keyed by cluster name.
   */
  clusterResults?: Record<string, QueryListResponse<DataType, ItemType, ErrorType>>;
  /**
   * Errors from individual clusters. Keyed by cluster name.
   */
  clusterErrors?: Record<string, ApiError | null> | null;
}

/**
 * Type guard to check if a response is a watch event
 */
export function isKubeListUpdateEvent<T extends KubeObjectInterface>(
  data: KubeListUpdateEvent<T> | KubeList<T>
): data is KubeListUpdateEvent<T> {
  return (
    'type' in data &&
    'object' in data &&
    ['ADDED', 'MODIFIED', 'DELETED', 'ERROR'].includes((data as KubeListUpdateEvent<T>).type)
  );
}

/**
 * Returns a single KubeObject.
 */
export function useKubeObject<K extends KubeObject>({
  kubeObjectClass,
  namespace,
  name,
  cluster: maybeCluster,
  queryParams,
}: {
  /** Class to instantiate the object with */
  kubeObjectClass: (new (...args: any) => K) & typeof KubeObject<any>;
  /** Object namespace */
  namespace?: string;
  /** Object name */
  name: string;
  /** Cluster name */
  cluster?: string;
  queryParams?: QueryParameters;
}): [K | null, ApiError | null] & QueryResponse<K, ApiError> {
  type Instance = K;
  const cluster = maybeCluster ?? getCluster() ?? '';
  const endpoint = useEndpoints(kubeObjectClass.apiEndpoint.apiInfo, cluster);

  const cleanedUpQueryParams = Object.fromEntries(
    Object.entries(queryParams ?? {}).filter(([, value]) => value !== undefined && value !== '')
  );

  const queryKey = useMemo(
    () => ['object', cluster, endpoint, namespace ?? '', name, cleanedUpQueryParams],
    [endpoint, namespace, name]
  );

  const client = useQueryClient();
  const query = useQuery<Instance | null, ApiError>({
    enabled: !!endpoint,
    placeholderData: null,
    staleTime: 5000,
    queryKey,
    queryFn: async () => {
      const url = makeUrl(
        [KubeObjectEndpoint.toUrl(endpoint!, namespace), name],
        cleanedUpQueryParams
      );
      const obj: KubeObjectInterface = await clusterFetch(url, {
        cluster,
      }).then(it => it.json());
      return new kubeObjectClass(obj) as Instance;
    },
  });

  const data: Instance | null = query.error ? null : query.data ?? null;

  useWebSocket<Instance>({
    url: () =>
      makeUrl([KubeObjectEndpoint.toUrl(endpoint!)], {
        ...cleanedUpQueryParams,
        watch: 1,
        fieldSelector: `metadata.name=${name}`,
      }),
    enabled: !!endpoint && !!data,
    cluster,
    onMessage(update) {
      if (update.type !== 'ADDED' && update.object) {
        client.setQueryData(queryKey, new kubeObjectClass(update.object));
      }
    },
  });

  // @ts-ignore
  return {
    data,
    error: query.error,
    isError: query.isError,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isSuccess: query.isSuccess,
    status: query.status,
    *[Symbol.iterator](): ArrayIterator<ApiError | K | null> {
      yield data;
      yield query.error;
    },
  };
}

/**
 * Test different endpoints to see which one is working.
 *
 * @params endpoints - List of possible endpoints
 * @returns Endpoint that works
 *
 * @throws Error
 * When no endpoints are working
 */
const getWorkingEndpoint = async (
  endpoints: KubeObjectEndpoint[],
  cluster: string,
  namespace?: string
) => {
  const promises = endpoints.map(endpoint => {
    return clusterFetch(KubeObjectEndpoint.toUrl(endpoint, namespace), {
      method: 'GET',
      cluster: cluster ?? getCluster() ?? '',
    }).then(it => {
      if (!it.ok) {
        throw new Error('error');
      }
      return endpoint;
    });
  });
  return Promise.any(promises);
};

/**
 * Checks and returns an endpoint that works from the list
 *
 * @params endpoints - List of possible endpoints
 */
export const useEndpoints = (
  endpoints: KubeObjectEndpoint[],
  cluster?: string,
  namespace?: string
) => {
  const { data: endpoint } = useQuery({
    enabled: endpoints.length > 1 && cluster !== undefined,
    queryKey: ['endpoints', endpoints],
    queryFn: () =>
      getWorkingEndpoint(endpoints, cluster!, namespace)
        .then(endpoints => endpoints)
        .catch(() => null),
  });

  if (cluster === null || cluster === undefined) return undefined;
  if (endpoints.length === 1) return endpoints[0];

  return endpoint;
};
