/** Phone setup text. The shop PC and the Worker both hand the phone this note. */

export function iphoneAutomationText(input: {
  url: string;
  token: string;
  ssid: string;
  address: string;
  lat: number;
  lng: number;
  radius: number;
  relayUrl?: string;
}): string {
  const header = `Authorization: Bearer ${input.token}`;
  const tagged = Boolean(input.relayUrl);
  const body = (event: "arrive" | "leave", trigger: "geo" | "wifi") =>
    tagged
      ? `{"event":"${event}","trigger":"${trigger}","ts":EVENT_ID,"eventId":"EVENT_ID"}`
      : `{"event":"${event}","trigger":"${trigger}"}`;
  const call = (event: "arrive" | "leave", trigger: "geo" | "wifi") => {
    const urls = !input.relayUrl ? [input.url] : event === "leave" ? [input.relayUrl] : [input.url, input.relayUrl];
    return urls.map((url) => [`POST ${url}`, header, body(event, trigger)].join("\n")).join("\n\n");
  };
  const lead = tagged
    ? ["Capture the current time in milliseconds once. Use that same number as ts and eventId on every post of that firing.", ""]
    : [];
  return [
    `Shop geofence — ${input.address}`,
    `Center ${input.lat}, ${input.lng}. Radius ${input.radius} m.`,
    "",
    ...lead,
    "Arrive",
    call("arrive", "geo"),
    "",
    "Leave",
    call("leave", "geo"),
    "",
    `Shop Wi-Fi — ${input.ssid}`,
    "",
    `Joined ${input.ssid}`,
    call("arrive", "wifi"),
    "",
    `Left ${input.ssid}`,
    call("leave", "wifi"),
  ].join("\n");
}

type Macro = {
  m_name: string;
  m_GUID: 0;
  m_enabled: true;
  aiGenerated: 1;
  m_triggerList: object[];
  m_actionList: object[];
  m_constraintList: [];
};

function httpAction(url: string, token: string, event: "arrive" | "leave", trigger: "geo" | "wifi", sig: string, tagged: boolean) {
  const body = tagged
    ? `{"event":"${event}","trigger":"${trigger}","ts":EVENT_ID,"eventId":"EVENT_ID"}`
    : JSON.stringify({ event, trigger });
  return {
    m_classType: "HttpRequestAction",
    m_url: url,
    m_httpMethod: "POST",
    m_contentType: "application/json",
    m_body: body,
    m_headerKeys: ["Authorization"],
    m_headerValues: [`Bearer ${token}`],
    m_SIGUID: sig,
    m_constraintList: [{ m_classType: "TriggerThatInvokedConstraint", m_SIGUID: `${sig}c` }],
  };
}

function actionUrls(url: string, relayUrl: string | undefined, event: "arrive" | "leave"): string[] {
  if (!relayUrl) return [url];
  if (event === "leave") return [relayUrl];
  return [url, relayUrl];
}

export function macroFile(input: {
  url: string;
  token: string;
  ssid: string;
  address: string;
  lat: number;
  lng: number;
  radius: number;
  relayUrl?: string;
}): { aiGenerated: number; macros: Macro[] } {
  const tagged = Boolean(input.relayUrl);
  const actions = (event: "arrive" | "leave", trigger: "geo" | "wifi", sig: string) =>
    actionUrls(input.url, input.relayUrl, event).map((url, index) =>
      httpAction(url, input.token, event, trigger, `${sig}${index === 0 ? "a" : "b"}`, tagged),
    );
  const geo = (name: string, enter: boolean, event: "arrive" | "leave", sig: string): Macro => ({
    m_name: name,
    m_GUID: 0,
    m_enabled: true,
    aiGenerated: 1,
    m_triggerList: [
      {
        m_classType: "GeofenceTrigger",
        m_latitude: input.lat,
        m_longitude: input.lng,
        m_radius: input.radius,
        m_triggerOnEnter: enter,
        m_locationName: input.address,
        m_SIGUID: sig,
      },
    ],
    m_actionList: actions(event, "geo", sig),
    m_constraintList: [],
  });
  const wifi = (name: string, state: 2 | 3, event: "arrive" | "leave", sig: string): Macro => ({
    m_name: name,
    m_GUID: 0,
    m_enabled: true,
    aiGenerated: 1,
    m_triggerList: [
      {
        m_classType: "WifiConnectionTrigger",
        m_SSID: input.ssid,
        m_wifiState: state,
        m_SIGUID: sig,
      },
    ],
    m_actionList: actions(event, "wifi", sig),
    m_constraintList: [],
  });
  return {
    aiGenerated: 1,
    macros: [
      geo("EZ Designs geofence arrive", true, "arrive", "112233445566771"),
      geo("EZ Designs geofence leave", false, "leave", "112233445566772"),
      wifi(`EZ Designs ${input.ssid} join`, 2, "arrive", "112233445566773"),
      wifi(`EZ Designs ${input.ssid} leave`, 3, "leave", "112233445566774"),
    ],
  };
}
