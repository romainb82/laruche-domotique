import Foundation

/// Le miroir Swift de `@domo/shared`.
///
/// Même règle d'or que côté TypeScript : on ne modélise pas des produits, on
/// modélise des capacités. Rien ici ne connaît la marque d'un module.
///
/// Ces types doivent rester alignés sur le serveur. Ce n'est pas une promesse
/// en l'air : `ContractTests` décode la vraie réponse du cerveau, donc toute
/// dérive du contrat casse la compilation des tests, pas l'app en production.

// MARK: - Grandeurs

public enum Metric: String, Codable, Sendable, CaseIterable {
    case temperature, humidity, lux, ph, orp, power
    case waterFlow = "water_flow"
    case contact, battery

    public var label: String {
        switch self {
        case .temperature: "Température"
        case .humidity: "Humidité"
        case .lux: "Luminosité"
        case .ph: "pH"
        case .orp: "Potentiel redox"
        case .power: "Puissance"
        case .waterFlow: "Débit"
        case .contact: "Ouverture"
        case .battery: "Batterie"
        }
    }

    public var unit: String {
        switch self {
        case .temperature: "°C"
        case .humidity, .battery: "%"
        case .lux: "lx"
        case .orp: "mV"
        case .power: "W"
        case .waterFlow: "m³/h"
        case .ph, .contact: ""
        }
    }
}

public enum DeviceType: String, Codable, Sendable {
    case light, dimmer, cover, thermostat, sensor
}

/// Fraîcheur de l'information.
///
/// Un capteur sur pile qui meurt ne renvoie pas d'erreur : il se tait. Sans
/// cette distinction, l'app afficherait une mesure de la semaine dernière comme
/// si elle venait d'arriver.
public enum Health: String, Codable, Sendable {
    case online, stale, offline

    public var isActionable: Bool { self == .online }
}

public enum CoverMotion: String, Codable, Sendable {
    case up, down
}

// MARK: - Capacités

/// L'état d'un équipement, exprimé en capacités.
///
/// Union discriminée sur `kind` côté JSON — d'où le `Codable` écrit à la main.
public enum Capability: Codable, Sendable, Equatable {
    case power(on: Bool)
    case dim(level: Double)
    case cover(position: Double, moving: CoverMotion?)
    case climate(setpoint: Double, ambient: Double, demand: Bool)
    case sensor(metric: Metric, value: Double, unit: String)

    private enum Keys: String, CodingKey {
        case kind, state, level, position, moving, setpoint, ambient, demand, metric, value, unit
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "switch":
            self = .power(on: try c.decode(Bool.self, forKey: .state))
        case "dim":
            self = .dim(level: try c.decode(Double.self, forKey: .level))
        case "cover":
            self = .cover(
                position: try c.decode(Double.self, forKey: .position),
                moving: try c.decodeIfPresent(CoverMotion.self, forKey: .moving)
            )
        case "climate":
            self = .climate(
                setpoint: try c.decode(Double.self, forKey: .setpoint),
                ambient: try c.decode(Double.self, forKey: .ambient),
                demand: try c.decode(Bool.self, forKey: .demand)
            )
        case "sensor":
            self = .sensor(
                metric: try c.decode(Metric.self, forKey: .metric),
                value: try c.decode(Double.self, forKey: .value),
                unit: try c.decode(String.self, forKey: .unit)
            )
        case let autre:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c,
                debugDescription: "Capacité inconnue « \(autre) » — le serveur est plus récent que l'app."
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .power(let on):
            try c.encode("switch", forKey: .kind); try c.encode(on, forKey: .state)
        case .dim(let level):
            try c.encode("dim", forKey: .kind); try c.encode(level, forKey: .level)
        case .cover(let position, let moving):
            try c.encode("cover", forKey: .kind)
            try c.encode(position, forKey: .position)
            try c.encodeIfPresent(moving, forKey: .moving)
        case .climate(let setpoint, let ambient, let demand):
            try c.encode("climate", forKey: .kind)
            try c.encode(setpoint, forKey: .setpoint)
            try c.encode(ambient, forKey: .ambient)
            try c.encode(demand, forKey: .demand)
        case .sensor(let metric, let value, let unit):
            try c.encode("sensor", forKey: .kind)
            try c.encode(metric, forKey: .metric)
            try c.encode(value, forKey: .value)
            try c.encode(unit, forKey: .unit)
        }
    }
}

// MARK: - État

/// L'état diffusé par le serveur.
///
/// `pending` est le troisième état visuel : ni allumé ni éteint, « en cours ».
/// Il vaut `true` entre l'envoi d'une commande et sa confirmation par le
/// matériel. C'est ce qui empêche l'application de mentir.
public struct DeviceState: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let caps: [Capability]
    public let health: Health
    public let lastSeen: String
    public let pending: Bool

    public init(id: String, caps: [Capability], health: Health, lastSeen: String, pending: Bool) {
        self.id = id; self.caps = caps; self.health = health
        self.lastSeen = lastSeen; self.pending = pending
    }

    public var isOn: Bool {
        for c in caps { if case .power(let on) = c { return on } }
        return false
    }

    public var level: Double? {
        for c in caps { if case .dim(let l) = c { return l } }
        return nil
    }

    public var coverPosition: Double? {
        for c in caps { if case .cover(let p, _) = c { return p } }
        return nil
    }

    public var coverMoving: CoverMotion? {
        for c in caps { if case .cover(_, let m) = c { return m } }
        return nil
    }

    public var climate: (setpoint: Double, ambient: Double, demand: Bool)? {
        for c in caps { if case .climate(let s, let a, let d) = c { return (s, a, d) } }
        return nil
    }

    public var measure: (metric: Metric, value: Double, unit: String)? {
        for c in caps { if case .sensor(let m, let v, let u) = c { return (m, v, u) } }
        return nil
    }
}

// MARK: - Commandes

public enum Command: Encodable, Sendable, Equatable {
    case power(on: Bool)
    case dim(level: Int)
    case cover(position: Int)
    case coverStop
    case climate(setpoint: Double)

    private enum Keys: String, CodingKey { case kind, state, level, position, setpoint }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .power(let on):
            try c.encode("switch", forKey: .kind); try c.encode(on, forKey: .state)
        case .dim(let level):
            try c.encode("dim", forKey: .kind); try c.encode(level, forKey: .level)
        case .cover(let position):
            try c.encode("cover", forKey: .kind); try c.encode(position, forKey: .position)
        case .coverStop:
            try c.encode("cover-stop", forKey: .kind)
        case .climate(let setpoint):
            try c.encode("climate", forKey: .kind); try c.encode(setpoint, forKey: .setpoint)
        }
    }
}

// MARK: - Configuration

public struct PlanRect: Codable, Sendable, Equatable {
    public let x, y, w, h: Double
}

public struct PlanOpening: Codable, Sendable, Equatable {
    public let x1, y1, x2, y2: Double
}

public enum ZoneKind: String, Codable, Sendable {
    case living, bedroom, bathroom, circulation, utility, outdoor, pool, general
}

public struct Zone: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let label: String
    public let kind: ZoneKind
    public let order: Int
    public let plan: [PlanRect]?
    public let heated: Bool

    public var isOnPlan: Bool { !(plan?.isEmpty ?? true) }
}

public struct Device: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let zoneId: String
    public let label: String
    public let type: DeviceType
    public let metric: Metric?
    public let order: Int
    public let opening: PlanOpening?

    /// Les champs `binding` et `sim` ne concernent que le serveur : on les
    /// ignore volontairement plutôt que de les traîner jusqu'à l'interface.
    private enum CodingKeys: String, CodingKey {
        case id, zoneId, label, type, metric, order, opening
    }

    public var isLight: Bool { type == .light || type == .dimmer }
}

public struct SceneConfig: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let label: String
    public let icon: String
    public let order: Int
}

public struct HeatingSettings: Codable, Sendable, Equatable {
    public let minSetpoint: Double
    public let maxSetpoint: Double
}

public struct PoolSettings: Codable, Sendable, Equatable {
    public let enabled: Bool
    public let phTarget: [Double]
}

public struct HouseConfig: Codable, Sendable, Equatable {
    public let house: HouseIdentity
    public let heating: HeatingSettings
    public let pool: PoolSettings
    public let zones: [Zone]
    public let devices: [Device]
    public let scenes: [SceneConfig]?

    public struct HouseIdentity: Codable, Sendable, Equatable {
        public let name: String
        public let timezone: String
    }
}

// MARK: - Canaux

public struct ConnectionStatus: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let label: String
    public let state: State
    public let detail: String?
    public let devices: Int

    public enum State: String, Codable, Sendable {
        case connected, connecting, error, disabled
    }
}
