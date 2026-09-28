{% autoescape false %}
# {{ q.title }}

- Quiz by: {{ q.quizmasters|join(', ') }} ({{ site.title }})
- Published: {{ q.date.isoformat() }}
- Slides: {{ q.slide_count }}
{% if q.event %}- Event: {{ q.event }}
{% endif %}
{% if q.tags %}- Topics: {{ q.tags|join(', ') }}
{% endif %}
- View online: {{ canonical }}
{% for d in q.downloads %}- Download {{ d.label }}: {{ absolute(d.url) }}
{% endfor %}

{{ q.summary }}

## Slides
{% for t in q.pages %}

### Slide {{ loop.index }}

{{ t.strip() or "(picture slide)" }}
{% endfor %}
{% endautoescape %}
