import MuiLink from '@mui/material/Link';
import React from 'react';
import { useDispatch } from 'react-redux';
import { Link as RouterLink } from 'react-router-dom';
import { KubeObject } from '../../lib/k8s/KubeObject';
import { createRouteURL, RouteURLProps } from '../../lib/router';
import { setSelectedResource } from '../../redux/drawerModeSlice';
import { useTypedSelector } from '../../redux/reducers/reducers';
import { LightTooltip } from './Tooltip';

export interface LinkBaseProps {
  /** The tooltip to display on hover. If true, the tooltip will be the link's text. */
  tooltip?: string | boolean;
}

export interface LinkProps extends LinkBaseProps {
  /** A key in the default routes object (given by router.tsx's getDefaultRoutes). */
  routeName: string;
  /** An object with corresponding params for the pattern to use. */
  params?: RouteURLProps;
  /** A string representation of query parameters. */
  search?: string;
  /** State to persist to the location. */
  state?: {
    [prop: string]: any;
  };
  drawerEnabled?: boolean;
}

export interface LinkObjectProps extends LinkBaseProps {
  kubeObject?: KubeObject | null;
  [prop: string]: any;
}

function PureLink(props: React.PropsWithChildren<LinkProps | LinkObjectProps>) {
  const { routeName, params = {}, search, state, ...otherProps } = props as LinkObjectProps;

  return (
    <MuiLink
      component={RouterLink}
      to={{
        pathname: createRouteURL(routeName, params),
        search,
        state,
      }}
      {...otherProps}
    >
      {props.children}
    </MuiLink>
  );
}

export default function Link(props: React.PropsWithChildren<LinkProps | LinkObjectProps>) {
  const drawerEnabled = useTypedSelector(state => state.drawerMode.isDetailDrawerEnabled);
  const dispatch = useDispatch();

  const { tooltip, kubeObject, ...otherProps } = props as LinkObjectProps;

  if (tooltip) {
    let tooltipText = '';
    if (typeof tooltip === 'string') {
      tooltipText = tooltip;
    } else if ((props as LinkObjectProps).kubeObject) {
      tooltipText = (props as LinkObjectProps).getName();
    } else if (typeof props.children === 'string') {
      tooltipText = props.children;
    }

    if (!!tooltipText) {
      return (
        <LightTooltip title={tooltipText} interactive>
          <span>
            <PureLink {...otherProps} />
          </span>
        </LightTooltip>
      );
    }
  }

  if ('kubeObject' in props && kubeObject) {
    {
      /* NOTE: there is an issue where TS would throw an error for using KubeObject<any> along with the return undefined, this seems to fix it
       * if we were to use dispatch(setSelectedResource(kubeObject!)); the error for returning kubeObject<any> & void would appear
       */
    }

    const kubeJSON = kubeObject.jsonData;
    return (
      <>
        {drawerEnabled === true && props.kubeObject ? (
          <MuiLink
            onClick={() => {
              if (drawerEnabled) {
                console.log('kubeObject', kubeObject);
                dispatch(setSelectedResource(kubeJSON!));
                window.history.pushState(
                  { path: kubeObject.getDetailsLink() },
                  '',
                  kubeObject.getDetailsLink()
                );
              }
            }}
          >
            {props.children || kubeObject.getName()}
          </MuiLink>
        ) : (
          <MuiLink component={RouterLink} to={kubeObject.getDetailsLink()} {...otherProps}>
            {props.children || kubeObject.getName()}
          </MuiLink>
        )}
      </>
    );
  }

  return <PureLink {...otherProps} />;
}
