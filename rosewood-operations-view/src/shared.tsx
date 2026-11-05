import React, {type ReactNode} from 'react';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import {ContentNotification} from '@commercetools-uikit/notifications';
export function Notice({error,message}:{error?:string;message?:string}) {
  return <React.Fragment>{error && <ContentNotification type="error">{error}</ContentNotification>}{message && <ContentNotification type="success">{message}</ContentNotification>}</React.Fragment>;
}
export function Section({title,children}:{title:string;children:ReactNode}) {
  return <section style={{borderTop:'1px solid #d9dce3',paddingTop:16}}><Spacings.Stack scale="m"><Text.Subheadline as="h4">{title}</Text.Subheadline>{children}</Spacings.Stack></section>;
}
export function NativeLink({url,label}:{url:string;label:string}) {
  return <a href={url} target="_blank" rel="noopener noreferrer">{label} ↗</a>;
}
