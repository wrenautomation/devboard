# Builds wren.excalidrawlib: every item gets a name and a category, sorted by category.
# The page's Icons panel searches name + category + tags. Sources live in src/ (brands from brands.js,
# the rest from libraries.excalidraw.com). usage: python3 -I build.py
import json,os,time,re
HERE=os.path.dirname(os.path.abspath(__file__)); SRC=os.path.join(HERE,"src")
BRANDS={
 "Social & video":"YouTube,X,TikTok,Instagram,Facebook,Meta,Threads,Reddit,Discord,Pinterest,Snapchat,Bluesky,Twitch,LinkedIn,Hacker News,Product Hunt,Y Combinator,Medium,Substack,Spotify,Apple Podcasts",
 "Ads & search":"Google Ads,Google,Google Maps,Google Search Console,Perplexity,Exa",
 "Email & messaging":"Gmail,Mailchimp,SendGrid,Resend,Customer.io,Instantly,Slack,WhatsApp,Telegram,Twilio",
 "Sales & CRM":"HubSpot,Calendly,Cal.com,Loom,Jobber,Clutch,Upwork,Fiverr,Trustpilot,Yelp",
 "Payments & shop":"Stripe,Wise,PayPal,Gumroad,QuickBooks,Shopify",
 "Tools & AI":"Notion,Airtable,Zapier,Figma,Webflow,WordPress,Framer,Canva,Hootsuite,OpenAI,Anthropic,Claude,Google Drive,Google Sheets",
 "Tech stack":"Cloudflare,Vercel,PostgreSQL,Apache Kafka,Redis,Docker,Kubernetes,GitHub,Node.js,React,TypeScript,Python,AWS,Restate",
}
BRAND_CAT={n.strip().lower():c for c,ns in BRANDS.items() for n in ns.split(",")}
SETS=[ # (file, category, tags)
 ("system-design","System design","server database cache queue"),
 ("systems-design-components","System design","cloud stream servers lb api"),
 ("systemdesignicons","System design","service cluster cache mapreduce"),
 ("architecture-diagram-components","System design","architecture vpc"),
 ("software-architecture","System design","architecture"),
 ("data-sources","System design","data source api"),
 ("drwnio","System design","drawio shapes"),
 ("redis-grafana","System design","redis grafana"),
 ("c4-architecture","System design","c4 container person"),
 ("aws-serverless","Cloud & AWS","aws lambda serverless"),
 ("decision-flow-control","Flow & decisions","decision condition yes no branch"),
 ("canvases","Business & planning","business model canvas value proposition"),
 ("customer-journey-map","Business & planning","customer journey persona funnel"),
 ("charts","Business & planning","chart graph"),
 ("post-it","Notes & people","sticky note post-it"),
 ("stick-figures","Notes & people","person people user stick"),
 ("technology-logos","Tech logos","logo"),
 ("it-logos","Tech logos","logo"),
 ("logos","Tech logos","logo"),
 ("data-science","Tech logos","data science ml"),
 ("some-common-cloud-apps","App logos","saas app logo"),
 ("comms-platform-icons","Email & messaging","email chat"),
 ("system-icons","UI icons","icon"),
 ("awesome-icons","UI icons","icon"),
 ("basic-ux-wireframing-elements","Wireframes","ui ux wireframe"),
 ("lo-fi-wireframing-kit","Wireframes","ui ux wireframe"),
]
ORDER=list(BRANDS)+["System design","Cloud & AWS","Flow & decisions","Business & planning","Notes & people","Tech logos","App logos","UI icons","Wireframes"]
def rnd(v):
  if isinstance(v,float): return round(v,1)
  if isinstance(v,list): return [rnd(x) for x in v]
  if isinstance(v,dict): return {k:rnd(x) for k,x in v.items()}
  return v
def pretty(set_name): return set_name.replace("-"," ").capitalize()
def text_of(els):
  t=" ".join(e.get("text","") for e in els if e.get("type")=="text")
  return re.sub(r"\s+"," ",t).strip()
items=[]; seen=set()
for it in json.load(open(os.path.join(SRC,"brands.excalidrawlib")))["libraryItems"]:
  it["category"]=BRAND_CAT.get(it["name"].lower(),"Tech stack"); it["tags"]="brand logo"; items.append(it)
for f,cat,tags in SETS:
  d=json.load(open(os.path.join(SRC,f)))
  src=d.get("libraryItems") or [{"elements":e} for e in d.get("library",[])]
  n=0
  for i,it in enumerate(src):
    els=[e for e in it["elements"] if not e.get("isDeleted")]
    if not els: continue
    n+=1
    name=(it.get("name") or "").strip()
    if not name or name.lower()==f: name=text_of(els)[:40]
    if len(name)<2: name=f"{pretty(f)} {n}"
    iid=it.get("id") or f"{f}-{i}"
    if iid in seen: iid=f"{f}-{i}"
    seen.add(iid)
    items.append({"id":iid,"status":"published","created":it.get("created") or int(time.time()*1000),
      "name":name[:1].upper()+name[1:],"category":cat,"tags":f"{tags} {pretty(f).lower()}","elements":els})
items.sort(key=lambda x:(ORDER.index(x["category"]),))
out=os.path.join(HERE,"wren.excalidrawlib")
json.dump(rnd({"type":"excalidrawlib","version":2,"source":"wren","libraryItems":items}),open(out,"w"),separators=(",",":"),ensure_ascii=False)
from collections import Counter
print(len(items),"items",os.path.getsize(out)//1024,"KB"); print(dict(Counter(x["category"] for x in items)))
