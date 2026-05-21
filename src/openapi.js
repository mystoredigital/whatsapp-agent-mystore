// OpenAPI 3.0 spec del WhatsApp Agent · My Store Digital.
// Documenta los endpoints del dashboard. No incluye /api/debug/* (uso interno)
// ni /oauth/* y /webhooks/ghl* (los consume GHL, no el dashboard).

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'WhatsApp Agent · My Store Digital',
    version: '0.1.0',
    description:
      'API REST del agente de WhatsApp: bandeja en vivo, multi-tenant + multi-número, ' +
      'toggle IA/humano, envío manual de mensajes y media, integración con GoHighLevel. ' +
      'Auth: cookie de embed SSO (clientes GHL) o Basic Auth (dashboard estándar).',
    contact: { name: 'My Store Digital', url: 'https://mystoredigital.cloud' },
  },
  servers: [
    { url: 'https://wa.mystoredigital.cloud', description: 'Producción (Dokploy)' },
    { url: 'http://localhost:3000', description: 'Local' },
  ],
  tags: [
    { name: 'Health', description: 'Estado del servicio' },
    { name: 'Tenants', description: 'Listado y estado por tenant (locationId)' },
    { name: 'Conversations', description: 'Bandeja, modo IA/humano, marcar leído, merge' },
    { name: 'Groups', description: 'Selección de grupos visibles para el operador' },
    { name: 'Numbers', description: 'Multi-número: alta, baja y relink por tenant' },
    { name: 'Send', description: 'Envío manual de texto y media' },
    { name: 'GHL', description: 'Operaciones específicas de GoHighLevel' },
    { name: 'Audit', description: 'Registro append-only de acciones del operador' },
    { name: 'API Keys', description: 'Tokens para acceso programático (Bearer). Una key fija el tenant.' },
    {
      name: 'Webhooks',
      description:
        'Suscripción a eventos salientes. El server hace POST al url registrado con header ' +
        '`X-Webhook-Signature: sha256=<hex>` donde hex = HMAC-SHA256(secret, body crudo). ' +
        'Eventos: message.received, message.sent, message.blocked, connection.changed, mode.changed. ' +
        'Reintentos: 2 con backoff (2s, 8s). Timeout: 10s. Solo entrega a webhooks no revocados.',
    },
  ],
  components: {
    securitySchemes: {
      basicAuth: { type: 'http', scheme: 'basic', description: 'DASHBOARD_USER / DASHBOARD_PASS' },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'API key con formato `wa_<keyId>_<secret>`. Crea una en POST /api/keys. La key fija el tenant.',
      },
      embedCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'embed_session',
        description: 'Cookie firmada emitida por POST /api/embed/sso (consumido por GHL custom page)',
      },
    },
    parameters: {
      TenantId: {
        name: 'tenantId',
        in: 'query',
        schema: { type: 'string' },
        description:
          'ID del tenant (locationId GHL). Opcional si la sesión embed ya lo fija por cookie.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
      },
      Ok: {
        type: 'object',
        properties: { ok: { type: 'boolean', example: true } },
        required: ['ok'],
      },
      Tenant: {
        type: 'object',
        properties: {
          tenantId: { type: 'string' },
          label: { type: 'string' },
          ghlConnected: { type: 'boolean' },
        },
      },
      Number: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Slug interno del número' },
          label: { type: 'string' },
          connection: {
            type: 'object',
            properties: {
              state: { type: 'string', enum: ['connected', 'qr', 'disconnected', 'logged_out'] },
              qr: { type: 'string', nullable: true, description: 'data URL del QR si state=qr' },
            },
          },
          metrics: {
            type: 'object',
            nullable: true,
            description: 'Métricas live de la sesión (null si aún no arrancó)',
            properties: {
              sent: { type: 'integer', description: 'Mensajes enviados por la IA' },
              manual: { type: 'integer', description: 'Mensajes enviados manualmente desde el dashboard' },
              received: { type: 'integer', description: 'Mensajes recibidos' },
              skippedRateLimit: { type: 'integer' },
              skippedQuietHours: { type: 'integer' },
              skippedGreylist: { type: 'integer' },
              skippedAiDisabled: { type: 'integer' },
              reconnects: { type: 'integer' },
              connectedAt: { type: 'integer', nullable: true, description: 'epoch ms del connect actual (null si desconectado)' },
              lastActivityAt: { type: 'integer', nullable: true, description: 'epoch ms del último envío/recepción' },
              limiter: {
                type: 'object',
                nullable: true,
                description: 'Estado del rate limiter de la sesión',
                properties: {
                  perChatCooldownMs: { type: 'integer' },
                  globalMaxPerMin: { type: 'integer' },
                  windowCount: { type: 'integer', description: 'Mensajes enviados en los últimos 60s' },
                  windowRemaining: { type: 'integer', description: 'Slots libres en el límite global/min' },
                },
              },
            },
          },
        },
      },
      Group: {
        type: 'object',
        properties: {
          jid: { type: 'string', example: '120363xxxxxx@g.us' },
          name: { type: 'string' },
          participantCount: { type: 'integer', nullable: true },
          enabled: { type: 'boolean' },
          hasMessages: { type: 'boolean' },
          stale: { type: 'boolean', description: 'Grupo ya no activo en WA pero con historial local' },
        },
      },
    },
  },
  security: [{ basicAuth: [] }, { bearerAuth: [] }, { embedCookie: [] }],
  paths: {
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness',
        security: [],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean' }, tenants: { type: 'integer' } },
                },
              },
            },
          },
        },
      },
    },
    '/api/tenants': {
      get: {
        tags: ['Tenants'],
        summary: 'Lista todos los tenants',
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { tenants: { type: 'array', items: { $ref: '#/components/schemas/Tenant' } } },
                },
              },
            },
          },
        },
      },
    },
    '/api/state': {
      get: {
        tags: ['Tenants'],
        summary: 'Snapshot del tenant (conversaciones, config, métricas)',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        responses: {
          200: { description: 'Snapshot serializado del tenant' },
          401: { description: 'No autorizado', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/config': {
      post: {
        tags: ['Tenants'],
        summary: 'Actualiza el system prompt del tenant',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['systemPrompt'],
                properties: { systemPrompt: { type: 'string', minLength: 1 } },
              },
            },
          },
        },
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } } },
      },
    },
    '/api/conversations/read': {
      post: {
        tags: ['Conversations'],
        summary: 'Marca una conversación como leída (WA + GHL)',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jid'],
                properties: { jid: { type: 'string', example: '5215512345678@s.whatsapp.net' } },
              },
            },
          },
        },
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/conversations/merge': {
      post: {
        tags: ['Conversations'],
        summary: 'Fusiona el historial de fromJid en toJid (mismo contacto bajo otro JID)',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['fromJid', 'toJid'],
                properties: { fromJid: { type: 'string' }, toJid: { type: 'string' } },
              },
            },
          },
        },
        responses: { 200: { description: 'OK con la conversación resultante' } },
      },
    },
    '/api/mode': {
      post: {
        tags: ['Conversations'],
        summary: 'Cambia el modo IA/humano de una conversación',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jid', 'mode'],
                properties: { jid: { type: 'string' }, mode: { type: 'string', enum: ['ai', 'human'] } },
              },
            },
          },
        },
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/ai-enabled': {
      post: {
        tags: ['Conversations'],
        summary: 'Pausa/reanuda la IA globalmente para el tenant',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['enabled'],
                properties: { enabled: { type: 'boolean' } },
              },
            },
          },
        },
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/groups': {
      get: {
        tags: ['Groups'],
        summary: 'Lista grupos del número (activos en WA + grupos con historial local)',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { groups: { type: 'array', items: { $ref: '#/components/schemas/Group' } } },
                },
              },
            },
          },
          503: { description: 'Sesión WhatsApp no conectada' },
        },
      },
    },
    '/api/groups/toggle': {
      post: {
        tags: ['Groups'],
        summary: 'Habilita/deshabilita un grupo en la bandeja',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jid', 'enabled'],
                properties: { jid: { type: 'string', example: '120363xxxxxx@g.us' }, enabled: { type: 'boolean' } },
              },
            },
          },
        },
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/numbers': {
      get: {
        tags: ['Numbers'],
        summary: 'Lista los números del tenant',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    numbers: { type: 'array', items: { $ref: '#/components/schemas/Number' } },
                    defaultId: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Numbers'],
        summary: 'Da de alta un número (sesión Baileys nueva)',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string', description: 'slug único del número' }, label: { type: 'string' } },
              },
            },
          },
        },
        responses: { 200: { description: 'OK con la entrada creada' } },
      },
    },
    '/api/numbers/{id}': {
      delete: {
        tags: ['Numbers'],
        summary: 'Da de baja un número',
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'OK' }, 404: { description: 'No existe' } },
      },
    },
    '/api/relink': {
      post: {
        tags: ['Numbers'],
        summary: 'Fuerza el re-pairing (regenera QR) de una sesión',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { numberId: { type: 'string' } } },
            },
          },
        },
        responses: { 200: { description: 'OK' }, 404: { description: 'Sesión no existe' } },
      },
    },
    '/api/send': {
      post: {
        tags: ['Send'],
        summary: 'Envía un mensaje de texto',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jid', 'text'],
                properties: {
                  jid: { type: 'string' },
                  text: { type: 'string' },
                  numberId: { type: 'string', description: 'Opcional — si no se especifica, se elige el número asociado al chat' },
                  quotedStanzaId: { type: 'string', description: 'Opcional — para responder citando un mensaje previo' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'OK' },
          404: { description: 'Sin sesión disponible' },
          429: {
            description: 'Rate limited',
            headers: {
              'Retry-After': { schema: { type: 'integer' }, description: 'Segundos hasta poder reintentar' },
            },
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    reason: { type: 'string', enum: ['per-chat cooldown', 'global rate limit'] },
                    retryAfterMs: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/send-media': {
      post: {
        tags: ['Send'],
        summary: 'Sube un archivo a R2 y lo envía por WhatsApp',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['jid', 'file'],
                properties: {
                  jid: { type: 'string' },
                  file: { type: 'string', format: 'binary' },
                  caption: { type: 'string' },
                  numberId: { type: 'string' },
                  quotedStanzaId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'OK con URL pública R2' },
          429: { description: 'Rate limited (mismo shape que POST /api/send)' },
          500: { description: 'R2 no configurado' },
        },
      },
    },
    '/api/stats': {
      get: {
        tags: ['Tenants'],
        summary: 'Resumen agregado (tenants conectados, sesiones, mensajes hoy/7d/30d, top chats)',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    asOf: { type: 'integer' },
                    scope: { type: 'string', description: 'tenantId o "all"' },
                    tenants: { type: 'object', properties: { total: { type: 'integer' }, connected: { type: 'integer' } } },
                    sessions: { type: 'object', properties: { total: { type: 'integer' }, open: { type: 'integer' } } },
                    conversations: {
                      type: 'object',
                      properties: {
                        total: { type: 'integer' },
                        activeToday: { type: 'integer' },
                        top: { type: 'array', items: { type: 'object' } },
                      },
                    },
                    messages: {
                      type: 'object',
                      properties: {
                        sent: { type: 'object', properties: { today: { type: 'integer' }, week: { type: 'integer' }, month: { type: 'integer' } } },
                        blocked: { type: 'object', properties: { today: { type: 'integer' }, week: { type: 'integer' }, month: { type: 'integer' } } },
                        modeChanges: { type: 'object', properties: { today: { type: 'integer' }, week: { type: 'integer' }, month: { type: 'integer' } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/audit': {
      get: {
        tags: ['Audit'],
        summary: 'Últimas acciones registradas (ordenadas de más reciente a más antigua)',
        parameters: [
          { name: 'tenant', in: 'query', schema: { type: 'string' }, description: 'Filtra por tenantId' },
          {
            name: 'type', in: 'query',
            schema: {
              type: 'string',
              enum: ['send', 'send-media', 'mode', 'ai-enabled', 'config', 'conv-merge',
                     'group-toggle', 'number-add', 'number-remove', 'relink', 'provision-provider'],
            },
          },
          { name: 'since', in: 'query', schema: { type: 'integer' }, description: 'Epoch ms — solo entries con ts >= since' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 200 } },
        ],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    entries: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          ts: { type: 'integer', description: 'epoch ms' },
                          tenantId: { type: 'string', nullable: true },
                          actor: { type: 'string', description: 'usuario Basic Auth o embed:<locationId|email>' },
                          type: { type: 'string' },
                          target: { type: 'object', nullable: true },
                          meta: { type: 'object', nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/keys': {
      get: {
        tags: ['API Keys'],
        summary: 'Lista las API keys del tenant (sin exponer el secreto)',
        security: [{ basicAuth: [] }, { embedCookie: [] }],
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    keys: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', description: '8 chars hex (público)' },
                          label: { type: 'string' },
                          tenantId: { type: 'string' },
                          createdAt: { type: 'integer' },
                          lastUsedAt: { type: 'integer', nullable: true },
                          revokedAt: { type: 'integer', nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'No se puede gestionar keys usando una key' },
        },
      },
      post: {
        tags: ['API Keys'],
        summary: 'Crea una API key nueva (devuelve el token UNA sola vez)',
        security: [{ basicAuth: [] }, { embedCookie: [] }],
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['label'],
                properties: { label: { type: 'string', description: 'Nombre humano (ej: "n8n-prod")' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'OK — el token completo solo aparece aquí',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    key: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        label: { type: 'string' },
                        tenantId: { type: 'string' },
                        token: { type: 'string', example: 'wa_a1b2c3d4_<32 hex chars>' },
                        createdAt: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'No se puede gestionar keys usando una key' },
        },
      },
    },
    '/api/webhooks': {
      get: {
        tags: ['Webhooks'],
        summary: 'Lista los webhooks del tenant (sin secret) + eventos soportados',
        security: [{ basicAuth: [] }, { embedCookie: [] }],
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    webhooks: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          tenantId: { type: 'string' },
                          url: { type: 'string' },
                          events: { type: 'array', items: { type: 'string' } },
                          createdAt: { type: 'integer' },
                          lastDeliveryAt: { type: 'integer', nullable: true },
                          lastStatus: { type: 'integer', nullable: true, description: 'HTTP status del último intento (0 si timeout/red)' },
                          lastError: { type: 'string', nullable: true },
                          revokedAt: { type: 'integer', nullable: true },
                        },
                      },
                    },
                    supportedEvents: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Webhooks'],
        summary: 'Crea un webhook (devuelve el secret UNA sola vez)',
        security: [{ basicAuth: [] }, { embedCookie: [] }],
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url', 'events'],
                properties: {
                  url: { type: 'string', format: 'uri', example: 'https://example.com/wa-hook' },
                  events: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: ['message.received', 'message.sent', 'message.blocked', 'connection.changed', 'mode.changed'],
                    },
                    minItems: 1,
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'OK — el secret completo solo aparece aquí' },
          400: { description: 'url inválida o events vacío' },
        },
      },
    },
    '/api/webhooks/{id}': {
      delete: {
        tags: ['Webhooks'],
        summary: 'Revoca un webhook (queda guardado pero ya no recibe entregas)',
        security: [{ basicAuth: [] }, { embedCookie: [] }],
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'OK' }, 404: { description: 'No existe' } },
      },
    },
    '/api/keys/{id}': {
      delete: {
        tags: ['API Keys'],
        summary: 'Revoca una API key (queda registrada pero ya no autentica)',
        security: [{ basicAuth: [] }, { embedCookie: [] }],
        parameters: [
          { $ref: '#/components/parameters/TenantId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'OK' },
          403: { description: 'No se puede gestionar keys usando una key' },
          404: { description: 'No existe' },
        },
      },
    },
    '/api/ghl/provision-provider': {
      post: {
        tags: ['GHL'],
        summary: 'Crea (o re-crea) el Conversation Provider en GHL para el tenant',
        parameters: [{ $ref: '#/components/parameters/TenantId' }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { force: { type: 'boolean', description: 'Re-provisionar aunque ya exista uno' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'OK con conversationProviderId' },
          400: { description: 'Tenant sin GHL conectado' },
        },
      },
    },
  },
};
