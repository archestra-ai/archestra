"""Session listing uses persisted cumulative snapshots, never sums of sampled spans."""
import json
from pathlib import Path

ROOT = Path(__file__).parent


def refresh_sessions():
    path = ROOT / 'dashboards/agent-sessions.json'
    d = json.loads(path.read_text())
    fields = {
        'first_request': ('First request', 'dateTimeAsIso'), 'last_request': ('Last request', 'dateTimeAsIso'),
        'agent': ('Agent', None), 'agent_type': ('Agent type', None), 'user': ('User', None),
        'models': ('Models', None), 'source': ('Source', None), 'auth_methods': ('Authentication', None), 'credentials': ('Credentials', None),
        'requests': ('Requests', 'short'), 'request_duration_ms': ('Total request time', 'ms'), 'elapsed_ms': ('Session elapsed', 'ms'),
        'estimated_cost': ('Estimated cost', 'currencyUSD'), 'billed_cost': ('Billed cost', 'currencyUSD'), 'subscription_cost': ('Subscription equivalent', 'currencyUSD'),
        'input_tokens': ('Input tokens', 'short'), 'output_tokens': ('Output tokens', 'short'), 'cache_read_tokens': ('Cache read tokens', 'short'), 'cache_write_tokens': ('Cache write tokens', 'short'), 'trace_id': ('Trace ID', None),
    }
    overrides = [{'matcher': {'id': 'byName', 'options': key}, 'properties': [{'id': 'displayName', 'value': title}] + ([{'id':'unit','value':unit}] if unit else [])} for key,(title,unit) in fields.items()]
    link = '/d/archestra-agent-sessions?var-sessionId=${__value.raw}&var-traceId=${__data.fields.trace_id}&var-traces_datasource=${traces_datasource}&var-logs_datasource=${logs_datasource}&${__url_time_range}'
    overrides.insert(0, {'matcher':{'id':'byName','options':'session_id'}, 'properties':[{'id':'displayName','value':'Session ID'}, {'id':'links','value':[{'title':'Inspect session logs and waterfall','url':link,'targetBlank':False}]}]})
    aggregate = {key: {'operation': 'aggregate', 'aggregations':['firstNotNull']} for key in fields}
    aggregate['session_id'] = {'operation':'groupby','aggregations':[]}
    d['panels'] = [
        {'id':3,'title':'Recent Agent Sessions','type':'table','gridPos':{'x':0,'y':3,'w':24,'h':12},
         'description':'Latest cumulative session summaries from the same persisted aggregation as the application Logs page. Totals cover the session, not only this time range. The query reads up to 5000 snapshots in the selected window; older inactive sessions may fall outside it. Request time sums inference durations; session elapsed includes time between requests. Credential names are metadata, never key values.',
         'datasource':{'type':'loki','uid':'${logs_datasource}'},
         'targets':[{'refId':'A','expr':'{service_name="Archestra"} | event_name="archestra.session.summary" | json | agent =~ ${agent_name:json}', 'queryType':'range','direction':'backward','maxLines':5000}],
         'options':{'showHeader':True,'cellHeight':'sm','sortBy':[{'displayName':'Last request','desc':True}]},
         'fieldConfig':{'defaults':{'custom':{'align':'auto','cellOptions':{'type':'auto'}}},'overrides':overrides},
         'transformations':[
             {'id':'extractFields','options':{'source':'Line','format':'json','replace':True}},
             {'id':'sortBy','options':{'sort':[{'field':'last_request','desc':True},{'field':'requests','desc':True}]}},
             {'id':'groupBy','options':{'fields':aggregate}},
             {'id':'organize','options':{'renameByName':{key+' (firstNotNull)':key for key in fields},'indexByName':{key:i for i,key in enumerate(['session_id',*fields])}}},
         ]},
        {'id':4,'title':'Session detail — $sessionId','type':'row','collapsed':False,'panels':[],'gridPos':{'x':0,'y':15,'w':24,'h':1}},
        {'id':8,'title':'Session Logs','type':'logs','gridPos':{'x':0,'y':16,'w':12,'h':22},'description':'Inference, tool and Guardrails operation logs plus correlated application logs for the selected session. Expand a log for metadata and trace correlation.',
         'datasource':{'type':'loki','uid':'${logs_datasource}'},'targets':[{'refId':'A','expr':'{service_name="Archestra"} | session_id = ${sessionId:json} | event_name != "archestra.session.summary"','direction':'forward','queryType':'range','maxLines':1000}],
         'options':{'showTime':True,'showLabels':False,'wrapLogMessage':True,'sortOrder':'Ascending','enableLogDetails':True}},
        {'id':10,'title':'Session Waterfall','type':'traces','gridPos':{'x':12,'y':16,'w':12,'h':22},'description':'All exported turns, inference, tool and Guardrails hook spans under the session trace identity. Native policy checks and consults are included in the hook boundary. Resume a session to append new spans; existing historical traces are not rewritten.',
         'datasource':{'type':'tempo','uid':'${traces_datasource}'},'targets':[{'refId':'A','query':'${traceId}','queryType':'traceId'}]},
    ]
    d['description'] = 'Application session summaries with correlated operation logs and the complete session trace waterfall.'
    for v in d['templating']['list']:
        if v['name']=='traceId': v['description']='Filled from the selected session row; stable across turns.'
    path.write_text(json.dumps(d,indent=2)+'\n')
