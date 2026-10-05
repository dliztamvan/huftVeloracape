const DEFAULT_SELLER_PRICE = 15000;
const DEFAULT_SELLER_DAYS = 15;

const SESSION_DAYS = 30;

const FEE_RULES = [
    [20000, 500],
    [100000, 1500],
    [500000, 4500],
    [1000000, 8500],
    [3000000, 12500],
    [5000000, 15500],
    [10000000, 20000],
    [25000000, 30000],
    [50000000, 40000],
    [75000000, 50000],
    [100000000, 60000],
    [Infinity, 75000]
];

function headers() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
            "Content-Type, Authorization, X-Setup-Key",
        "Access-Control-Allow-Methods":
            "GET,POST,PUT,DELETE,OPTIONS"
    };
}

function json(data, status = 200) {
    return new Response(
        JSON.stringify(data),
        {
            status,
            headers: {
                ...headers(),
                "Content-Type":
                    "application/json; charset=utf-8"
            }
        }
    );
}

function makeId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function now() {
    return new Date().toISOString();
}

function futureDays(days) {
    return new Date(
        Date.now() + days * 86400000
    ).toISOString();
}

async function readBody(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

async function sha256(text) {
    const data =
        new TextEncoder().encode(text);

    const hash =
        await crypto.subtle.digest(
            "SHA-256",
            data
        );

    return [...new Uint8Array(hash)]
        .map(
            x => x.toString(16).padStart(2, "0")
        )
        .join("");
}

async function passwordHash(password) {
    const salt = crypto.randomUUID();

    const hash = await sha256(
        `${salt}:${password}`
    );

    return `${salt}:${hash}`;
}

async function passwordVerify(
    password,
    stored
) {
    const parts = String(stored).split(":");

    if (parts.length !== 2) {
        return false;
    }

    const salt = parts[0];
    const hash = parts[1];

    return (
        hash ===
        await sha256(`${salt}:${password}`)
    );
}

async function setting(
    env,
    key,
    fallback
) {
    const row =
        await env.DB
            .prepare(
                "SELECT value FROM app_settings WHERE key=?"
            )
            .bind(key)
            .first();

    return row?.value ?? fallback;
}

function adminFee(price) {
    const value = Number(price);

    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }

    for (const [limit, fee] of FEE_RULES) {
        if (value < limit) {
            return fee;
        }
    }

    return 75000;
}

async function getUser(
    request,
    env
) {
    const auth =
        request.headers.get(
            "Authorization"
        );

    if (!auth) {
        return null;
    }

    const token =
        auth.replace(
            /^Bearer\s+/i,
            ""
        );

    if (!token) {
        return null;
    }

    return await env.DB
        .prepare(`
            SELECT u.*
            FROM sessions s
            JOIN users u
              ON u.id=s.user_id
            WHERE s.token=?
              AND s.expires_at>?
        `)
        .bind(token, now())
        .first();
}

function publicUser(user) {
    if (!user) {
        return null;
    }

    return {
        id: user.id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        name: user.name,
        isAdmin: Boolean(user.is_admin),
        sellerStatus: user.seller_status,
        sellerUntil: user.seller_until,
        balance: Number(user.balance || 0),
        online: Boolean(user.online)
    };
}

async function requireUser(
    request,
    env
) {
    const user =
        await getUser(request, env);

    if (!user) {
        throw new Error("UNAUTHORIZED");
    }

    return user;
}

async function requireAdmin(
    request,
    env
) {
    const user =
        await requireUser(
            request,
            env
        );

    if (!user.is_admin) {
        throw new Error("ADMIN_ONLY");
    }

    return user;
}

function isSeller(user) {
    if (!user?.seller_until) {
        return false;
    }

    return (
        new Date(
            user.seller_until
        ).getTime() > Date.now()
    );
}

async function product(
    env,
    id
) {
    return await env.DB
        .prepare(`
            SELECT
                p.*,
                u.username AS seller_username,
                u.name AS seller_name
            FROM products p
            JOIN users u
              ON u.id=p.seller_id
            WHERE p.id=?
        `)
        .bind(id)
        .first();
}

export default {

    async fetch(
        request,
        env
    ) {

        if (
            request.method ===
            "OPTIONS"
        ) {
            return new Response(
                null,
                {
                    status: 204,
                    headers: headers()
                }
            );
        }

        const url =
            new URL(request.url);

        const path =
            url.pathname.replace(
                /\/+$/,
                ""
            ) || "/";

        try {

            /*
             * HEALTH
             */

            if (
                path === "/" ||
                path === "/health"
            ) {
                return json({
                    ok: true,
                    service:
                        "Velora Backend",
                    version: "18.0",
                    database:
                        "Cloudflare D1"
                });
            }

            /*
             * CONFIG
             */

            if (
                path === "/config" &&
                request.method === "GET"
            ) {

                return json({
                    ok: true,

                    sellerPrice:
                        Number(
                            await setting(
                                env,
                                "seller_price",
                                DEFAULT_SELLER_PRICE
                            )
                        ),

                    sellerDays:
                        Number(
                            await setting(
                                env,
                                "seller_days",
                                DEFAULT_SELLER_DAYS
                            )
                        ),

                    qris:
                        await setting(
                            env,
                            "qris_text",
                            "Belum diatur admin"
                        ),

                    qrisImage:
                        await setting(
                            env,
                            "qris_image",
                            ""
                        ),

                    adminFeeRules:
                        FEE_RULES.map(
                            ([max, fee]) => ({
                                max:
                                    Number.isFinite(
                                        max
                                    )
                                        ? max
                                        : null,
                                fee
                            })
                        )
                });
            }

            /*
             * FEE
             */

            if (
                path === "/fee" &&
                request.method === "GET"
            ) {

                const price =
                    Number(
                        url.searchParams.get(
                            "price"
                        ) || 0
                    );

                const fee =
                    adminFee(price);

                return json({
                    ok: true,
                    price,
                    adminFee: fee,
                    total:
                        price + fee
                });
            }

            /*
             * REGISTER
             */

            if (
                path ===
                    "/auth/register" &&
                request.method === "POST"
            ) {

                const body =
                    await readBody(
                        request
                    );

                const username =
                    String(
                        body.username ||
                            ""
                    )
                        .trim()
                        .toLowerCase();

                const password =
                    String(
                        body.password ||
                            ""
                    );

                const phone =
                    String(
                        body.phone ||
                            ""
                    ).trim();

                const email =
                    String(
                        body.email ||
                            ""
                    )
                        .trim()
                        .toLowerCase() ||
                    null;

                const name =
                    String(
                        body.name ||
                            username
                    ).trim();

                if (
                    username.length <
                        3 ||
                    password.length <
                        6
                ) {
                    return json(
                        {
                            error:
                                "Username minimal 3 karakter dan password minimal 6 karakter."
                        },
                        400
                    );
                }

                if (!phone) {
                    return json(
                        {
                            error:
                                "Nomor HP wajib diisi."
                        },
                        400
                    );
                }

                const exists =
                    await env.DB
                        .prepare(`
                            SELECT id
                            FROM users
                            WHERE username=?
                               OR phone=?
                               OR (
                                   ? IS NOT NULL
                                   AND email=?
                               )
                        `)
                        .bind(
                            username,
                            phone,
                            email,
                            email
                        )
                        .first();

                if (exists) {
                    return json(
                        {
                            error:
                                "Username, nomor HP, atau email sudah digunakan."
                        },
                        409
                    );
                }

                const hash =
                    await passwordHash(
                        password
                    );

                const userId =
                    makeId("usr");

                await env.DB
                    .prepare(`
                        INSERT INTO users
                        (
                            id,
                            username,
                            email,
                            phone,
                            name,
                            password_hash
                        )
                        VALUES(?,?,?,?,?,?)
                    `)
                    .bind(
                        userId,
                        username,
                        email,
                        phone,
                        name,
                        hash
                    )
                    .run();

                return json(
                    {
                        ok: true,
                        user: {
                            id: userId,
                            username,
                            phone,
                            name
                        }
                    },
                    201
                );
            }

            /*
             * LOGIN
             */

            if (
                path ===
                    "/auth/login" &&
                request.method === "POST"
            ) {

                const body =
                    await readBody(
                        request
                    );

                const login =
                    String(
                        body.username ||
                            body.email ||
                            body.phone ||
                            ""
                    )
                        .trim()
                        .toLowerCase();

                const password =
                    String(
                        body.password ||
                            ""
                    );

                const user =
                    await env.DB
                        .prepare(`
                            SELECT *
                            FROM users
                            WHERE lower(username)=?
                               OR lower(email)=?
                               OR phone=?
                        `)
                        .bind(
                            login,
                            login,
                            login
                        )
                        .first();

                if (
                    !user ||
                    !(
                        await passwordVerify(
                            password,
                            user.password_hash
                        )
                    )
                ) {
                    return json(
                        {
                            error:
                                "Username/password salah."
                        },
                        401
                    );
                }

                const token =
                    crypto.randomUUID() +
                    "." +
                    crypto.randomUUID();

                const expires =
                    futureDays(
                        SESSION_DAYS
                    );

                await env.DB
                    .prepare(`
                        INSERT INTO sessions
                        (
                            token,
                            user_id,
                            expires_at
                        )
                        VALUES(?,?,?)
                    `)
                    .bind(
                        token,
                        user.id,
                        expires
                    )
                    .run();

                await env.DB
                    .prepare(`
                        UPDATE users
                        SET online=1,
                            last_seen=?
                        WHERE id=?
                    `)
                    .bind(
                        now(),
                        user.id
                    )
                    .run();

                return json({
                    ok: true,
                    token,
                    expiresAt:
                        expires,
                    user:
                        publicUser(
                            user
                        )
                });
            }

            /*
             * LOGOUT
             */

            if (
                path ===
                    "/auth/logout" &&
                request.method === "POST"
            ) {

                const auth =
                    request.headers.get(
                        "Authorization"
                    );

                if (auth) {
                    const token =
                        auth.replace(
                            /^Bearer\s+/i,
                            ""
                        );

                    await env.DB
                        .prepare(
                            "DELETE FROM sessions WHERE token=?"
                        )
                        .bind(token)
                        .run();
                }

                return json({
                    ok: true
                });
            }

            /*
             * ME
             */

            if (
                path === "/me" &&
                request.method === "GET"
            ) {

                const user =
                    await requireUser(
                        request,
                        env
                    );

                return json({
                    ok: true,
                    user:
                        publicUser(
                            user
                        )
                });
            }

            /*
             * PRODUCTS LIST
             */

            if (
                path === "/products" &&
                request.method === "GET"
            ) {

                const game =
                    String(
                        url.searchParams.get(
                            "game"
                        ) || ""
                    ).trim();

                const q =
                    String(
                        url.searchParams.get(
                            "q"
                        ) || ""
                    ).trim();

                let sql = `
                    SELECT
                        p.*,
                        u.username
                            AS seller_username,
                        u.name
                            AS seller_name
                    FROM products p
                    JOIN users u
                      ON u.id=p.seller_id
                    WHERE p.status='ACTIVE'
                `;

                const params = [];

                if (game) {
                    sql +=
                        " AND lower(p.game)=lower(?)";

                    params.push(game);
                }

                if (q) {

                    sql += `
                        AND (
                            lower(p.title)
                                LIKE lower(?)
                            OR lower(p.game)
                                LIKE lower(?)
                            OR lower(
                                p.description
                            )
                                LIKE lower(?)
                        )
                    `;

                    const search =
                        `%${q}%`;

                    params.push(
                        search,
                        search,
                        search
                    );
                }

                sql += `
                    ORDER BY
                        p.created_at DESC
                    LIMIT 100
                `;

                const rows =
                    await env.DB
                        .prepare(sql)
                        .bind(...params)
                        .all();

                return json({
                    ok: true,

                    products:
                        rows.results.map(
                            p => ({
                                ...p,
                                price:
                                    Number(
                                        p.price
                                    ),
                                photos:
                                    JSON.parse(
                                        p.photos ||
                                            "[]"
                                    )
                            })
                        )
                });
            }

            /*
             * PRODUCT CREATE
             */

            if (
                path === "/products" &&
                request.method === "POST"
            ) {

                const user =
                    await requireUser(
                        request,
                        env
                    );

                if (
                    !isSeller(user)
                ) {
                    return json(
                        {
                            error:
                                "Akun seller belum aktif."
                        },
                        403
                    );
                }

                const body =
                    await readBody(
                        request
                    );

                const game =
                    String(
                        body.game || ""
                    ).trim();

                const title =
                    String(
                        body.title || ""
                    ).trim();

                const price =
                    Number(
                        body.price || 0
                    );

                const description =
                    String(
                        body.description ||
                            ""
                    );

                const photos =
                    Array.isArray(
                        body.photos
                    )
                        ? body.photos
                        : [];

                if (
                    !game ||
                    !title ||
                    !Number.isInteger(
                        price
                    ) ||
                    price <= 0
                ) {
                    return json(
                        {
                            error:
                                "Game, judul, dan harga wajib valid."
                        },
                        400
                    );
                }

                const productId =
                    makeId("prd");

                await env.DB
                    .prepare(`
                        INSERT INTO products
                        (
                            id,
                            seller_id,
                            game,
                            title,
                            price,
                            description,
                            photos,
                            status
                        )
                        VALUES(
                            ?,
                            ?,
                            ?,
                            ?,
                            ?,
                            ?,
                            ?,
                            'PENDING'
                        )
                    `)
                    .bind(
                        productId,
                        user.id,
                        game,
                        title,
                        price,
                        description,
                        JSON.stringify(
                            photos
                        )
                    )
                    .run();

                return json(
                    {
                        ok: true,
                        id: productId,
                        status:
                            "PENDING"
                    },
                    201
                );
            }

            /*
             * PRODUCT DETAIL
             */

            if (
                path.startsWith(
                    "/products/"
                ) &&
                request.method === "GET"
            ) {

                const productId =
                    path.split("/")[2];

                const p =
                    await product(
                        env,
                        productId
                    );

                if (!p) {
                    return json(
                        {
                            error:
                                "Produk tidak ditemukan."
                        },
                        404
                    );
                }

                return json({
                    ok: true,
                    product: {
                        ...p,
                        price:
                            Number(
                                p.price
                            ),
                        photos:
                            JSON.parse(
                                p.photos ||
                                    "[]"
                            )
                    }
                });
            }

            /*
             * PRODUCT DELETE
             */

            if (
                path.startsWith(
                    "/products/"
                ) &&
                request.method === "DELETE"
            ) {

                const user =
                    await requireUser(
                        request,
                        env
                    );

                const productId =
                    path.split("/")[2];

                const p =
                    await product(
                        env,
                        productId
                    );

                if (!p) {
                    return json(
                        {
                            error:
                                "Produk tidak ditemukan."
                        },
                        404
                    );
                }

                if (
                    p.seller_id !==
                        user.id &&
                    !user.is_admin
                ) {
                    return json(
                        {
                            error:
                                "Forbidden"
                        },
                        403
                    );
                }

                await env.DB
                    .prepare(`
                        UPDATE products
                        SET status='DELETED'
                        WHERE id=?
                    `)
                    .bind(productId)
                    .run();

                return json({
                    ok: true
                });
            }

            /*
             * SELLER STATUS
             */

            if (
                path ===
                    "/seller/status" &&
                request.method === "GET"
            ) {

                const user =
                    await requireUser(
                        request,
                        env
                    );

                return json({
                    ok: true,
                    active:
                        isSeller(user),
                    status:
                        user.seller_status,
                    sellerUntil:
                        user.seller_until
                });
            }

            /*
             * SELLER PAYMENT
             */

            if (
                path ===
                    "/seller/pay" &&
                request.method === "POST"
            ) {

                const user =
                    await requireUser(
                        request,
                        env
                    );

                const amount =
                    Number(
                        await setting(
                            env,
                            "seller_price",
                            DEFAULT_SELLER_PRICE
                        )
                    );

                const days =
                    Number(
                        await setting(
                            env,
                            "seller_days",
                            DEFAULT_SELLER_DAYS
                        )
                    );

                const body =
                    await readBody(
                        request
                    );

                const paymentId =
                    makeId("sp");

                await env.DB
                    .prepare(`
                        INSERT INTO seller_payments
                        (
                            id,
                            user_id,
                            amount,
                            days,
                            method,
                            proof
                        )
                        VALUES(?,?,?,?,?,?)
                    `)
                    .bind(
                        paymentId,
                        user.id,
                        amount,
                        days,
                        String(
                            body.method ||
                                "QRIS"
                        ),
                        String(
                            body.proof ||
                                ""
                        )
                    )
                    .run();

                return json({
                    ok: true,
                    paymentId,
                    amount,
                    days,
                    status:
                        "PENDING"
                });
            }

            /*
             * CREATE ORDER
             */

            if (
                path === "/orders" &&
                request.method === "POST"
            ) {

                const user =
                    await requireUser(
                        request,
                        env
                    );

                const body =
                    await readBody(
                        request
                    );

                const p =
                    await product(
                        env,
                        String(
                            body.productId ||
                                ""
                        )
                    );

                if (
                    !p ||
                    p.status !==
                        "ACTIVE"
                ) {
                    return json(
                        {
                            error:
                                "Produk tidak tersedia."
                        },
                        404
                    );
                }

                if (
                    p.seller_id ===
                    user.id
                ) {
                    return json(
                        {
                            error:
                                "Tidak bisa membeli produk sendiri."
                        },
                        400
                    );
                }

                const price =
                    Number(p.price);

                const fee =
                    adminFee(price);

                const total =
                    price + fee;

                const orderId =
                    makeId("ord");

                await env.DB
                    .prepare(`
                        INSERT INTO orders
                        (
                            id,
                            buyer_id,
                            seller_id,
                            product_id,
                            price,
                            admin_fee,
                            total,
                            payment_method
                        )
                        VALUES(
                            ?,
                            ?,
                            ?,
                            ?,
                            ?,
                            ?,
                            ?,
                            ?
                        )
                    `)
                    .bind(
                        orderId,
                        user.id,
                        p.seller_id,
                        p.id,
                        price,
                        fee,
                        total,
                        String(
                            body.paymentMethod ||
                                "QRIS"
                        )
                    )
                    .run();

                await env.DB
                    .prepare(`
                        UPDATE products
                        SET status='RESERVED'
                        WHERE id=?
                          AND status='ACTIVE'
                    `)
                    .bind(p.id)
                    .run();

                return json(
                    {
                        ok: true,
                        orderId,
                        price,
                        adminFee: fee,
                        total,
                        status:
                            "WAITING_PAYMENT"
                    },
                    201
                );
            }

            /*
             * ORDER LIST
             */

            if (
                path === "/orders" &&
                request.method === "GET"
            ) {

                const user =
                    await requireUser(
                        request,
                        env
                    );

                const rows =
                    await env.DB
                        .prepare(`
                            SELECT
                                o.*,
                                p.title,
                                p.game,
                                b.username
                                    AS buyer_username,
                                s.username
                                    AS seller_username
                            FROM orders o
                            JOIN products p
                              ON p.id=o.product_id
                            JOIN users b
                              ON b.id=o.buyer_id
                            JOIN users s
                              ON s.id=o.seller_id
                            WHERE
                                o.buyer_id=?
                                OR o.seller_id=?
                            ORDER BY
                                o.created_at DESC
                        `)
                        .bind(
                            user.id,
                            user.id
                        )
                        .all();

                return json({
                    ok: true,
                    orders:
                        rows.results
                });
            }

            /*
             * ORDER PAID
             */

            if (
                path.startsWith(
                    "/orders/"
                ) &&
                path.endsWith(
                    "/paid"
                ) &&
                request.method ===
                    "POST"
            ) {

                const user =
                    await requireUser(
                        request,
                        env
                    );

                const orderId =
                    path.split("/")[2];

                const order =
                    await env.DB
                        .prepare(
                            "SELECT * FROM orders WHERE id=?"
                        )
                        .bind(orderId)
                        .first();

                if (!order) {
                    return json(
                        {
                            error:
                                "Order tidak ditemukan."
                        },
                        404
                    );
                }

                if (
                    order.buyer_id !==
                    user.id
                ) {
                    return json(
                        {
                            error:
                                "Buyer only"
                        },
                        403
                    );
                }

                const body =
                    await readBody(
                        request
                    );

                await env.DB
                    .prepare(`
                        UPDATE orders
                        SET
                            status='PAYMENT_REVIEW',
                            payment_proof=?,
                            paid_at=?
                        WHERE id=?
                    `)
                    .bind(
                        String(
                            body.proof ||
                                ""
                        ),
                        now(),
                        orderId
                    )
                    .run();

                return json({
                    ok: true
                });
            }

            /*
             * ORDER COMPLETE
             */

            if (
                path.startsWith(
                    "/orders/"
                ) &&
                path.endsWith(
                    "/complete"
                ) &&
                request.method ===
                    "POST"
            ) {

                const user =
                    await requireUser(
                        request,
                        env
                    );

                const orderId =
                    path.split("/")[2];

                const order =
                    await env.DB
                        .prepare(
                            "SELECT * FROM orders WHERE id=?"
                        )
                        .bind(orderId)
                        .first();

                if (!order) {
                    return json(
                        {
                            error:
                                "Order tidak ditemukan."
                        },
                        404
                    );
                }

                if (
                    order.seller_id !==
                        user.id &&
                    !user.is_admin
                ) {
                    return json(
                        {
                            error:
                                "Seller/admin only"
                        },
                        403
                    );
                }

                await env.DB
                    .prepare(`
                        UPDATE orders
                        SET
                            status='COMPLETED',
                            completed_at=?
                        WHERE id=?
                    `)
                    .bind(
                        now(),
                        orderId
                    )
                    .run();

                await env.DB
                    .prepare(`
                        UPDATE products
                        SET status='SOLD'
                        WHERE id=?
                    `)
                    .bind(
                        order.product_id
                    )
                    .run();

                await env.DB
                    .prepare(`
                        UPDATE users
                        SET balance=balance+?
                        WHERE id=?
                    `)
                    .bind(
                        Number(
                            order.price
                        ),
                        order.seller_id
                    )
                    .run();

                return json({
                    ok: true
                });
            }

            /*
             * ADMIN STATS
             */

            if (
                path ===
                    "/admin/stats" &&
                request.method === "GET"
            ) {

                await requireAdmin(
                    request,
                    env
                );

                const users =
                    await env.DB
                        .prepare(
                            "SELECT COUNT(*) AS count FROM users"
                        )
                        .first();

                const products =
                    await env.DB
                        .prepare(
                            "SELECT COUNT(*) AS count FROM products"
                        )
                        .first();

                const orders =
                    await env.DB
                        .prepare(
                            "SELECT COUNT(*) AS count FROM orders"
                        )
                        .first();

                return json({
                    ok: true,
                    stats: {
                        users:
                            Number(
                                users.count
                            ),
                        products:
                            Number(
                                products.count
                            ),
                        orders:
                            Number(
                                orders.count
                            )
                    }
                });
            }

            /*
             * ADMIN SETTINGS
             */

            if (
                path ===
                    "/admin/settings" &&
                request.method === "PUT"
            ) {

                await requireAdmin(
                    request,
                    env
                );

                const body =
                    await readBody(
                        request
                    );

                const allowed = [
                    "seller_price",
                    "seller_days",
                    "qris_text",
                    "qris_image"
                ];

                for (
                    const key of allowed
                ) {

                    if (
                        body[key] ===
                        undefined
                    ) {
                        continue;
                    }

                    await env.DB
                        .prepare(`
                            INSERT INTO
                                app_settings
                            (
                                key,
                                value
                            )
                            VALUES(?,?)
                            ON CONFLICT(key)
                            DO UPDATE SET
                                value=
                                    excluded.value
                        `)
                        .bind(
                            key,
                            String(
                                body[key]
                            )
                        )
                        .run();
                }

                return json({
                    ok: true
                });
            }

            /*
             * ADMIN PRODUCTS
             */

            if (
                path ===
                    "/admin/products" &&
                request.method === "GET"
            ) {

                await requireAdmin(
                    request,
                    env
                );

                const rows =
                    await env.DB
                        .prepare(`
                            SELECT *
                            FROM products
                            ORDER BY
                                created_at DESC
                            LIMIT 500
                        `)
                        .all();

                return json({
                    ok: true,
                    products:
                        rows.results
                });
            }

            /*
             * ADMIN APPROVE PRODUCT
             */

            if (
                path ===
                    "/admin/products/approve" &&
                request.method === "POST"
            ) {

                await requireAdmin(
                    request,
                    env
                );

                const body =
                    await readBody(
                        request
                    );

                await env.DB
                    .prepare(`
                        UPDATE products
                        SET status='ACTIVE'
                        WHERE id=?
                    `)
                    .bind(
                        String(
                            body.productId
                        )
                    )
                    .run();

                return json({
                    ok: true
                });
            }

            /*
             * ADMIN SELLER PAYMENTS
             */

            if (
                path ===
                    "/admin/seller-payments" &&
                request.method === "GET"
            ) {

                await requireAdmin(
                    request,
                    env
                );

                const rows =
                    await env.DB
                        .prepare(`
                            SELECT
                                sp.*,
                                u.username,
                                u.phone
                            FROM
                                seller_payments sp
                            JOIN users u
                              ON u.id=sp.user_id
                            ORDER BY
                                sp.created_at DESC
                        `)
                        .all();

                return json({
                    ok: true,
                    payments:
                        rows.results
                });
            }

            /*
             * ADMIN REVIEW SELLER
             */

            if (
                path ===
                    "/admin/seller-payments/review" &&
                request.method === "POST"
            ) {

                await requireAdmin(
                    request,
                    env
                );

                const body =
                    await readBody(
                        request
                    );

                const payment =
                    await env.DB
                        .prepare(
                            "SELECT * FROM seller_payments WHERE id=?"
                        )
                        .bind(
                            String(
                                body.paymentId
                            )
                        )
                        .first();

                if (!payment) {
                    return json(
                        {
                            error:
                                "Pembayaran tidak ditemukan."
                        },
                        404
                    );
                }

                const status =
                    String(
                        body.status ||
                            "APPROVED"
                    ).toUpperCase();

                if (
                    status ===
                    "APPROVED"
                ) {

                    const until =
                        futureDays(
                            Number(
                                payment.days
                            )
                        );

                    await env.DB
                        .prepare(`
                            UPDATE
                                seller_payments
                            SET
                                status='APPROVED',
                                reviewed_at=?
                            WHERE id=?
                        `)
                        .bind(
                            now(),
                            payment.id
                        )
                        .run();

                    await env.DB
                        .prepare(`
                            UPDATE users
                            SET
                                seller_status='ACTIVE',
                                seller_until=?
                            WHERE id=?
                        `)
                        .bind(
                            until,
                            payment.user_id
                        )
                        .run();

                } else {

                    await env.DB
                        .prepare(`
                            UPDATE
                                seller_payments
                            SET
                                status=?,
                                reviewed_at=?
                            WHERE id=?
                        `)
                        .bind(
                            status,
                            now(),
                            payment.id
                        )
                        .run();
                }

                return json({
                    ok: true
                });
            }

            /*
             * ADMIN ORDERS
             */

            if (
                path ===
                    "/admin/orders" &&
                request.method === "GET"
            ) {

                await requireAdmin(
                    request,
                    env
                );

                const rows =
                    await env.DB
                        .prepare(`
                            SELECT *
                            FROM orders
                            ORDER BY
                                created_at DESC
                            LIMIT 500
                        `)
                        .all();

                return json({
                    ok: true,
                    orders:
                        rows.results
                });
            }

            /*
             * ADMIN APPROVE PAYMENT
             */

            if (
                path ===
                    "/admin/orders/approve-payment" &&
                request.method === "POST"
            ) {

                await requireAdmin(
                    request,
                    env
                );

                const body =
                    await readBody(
                        request
                    );

                await env.DB
                    .prepare(`
                        UPDATE orders
                        SET status='PAID'
                        WHERE id=?
                    `)
                    .bind(
                        String(
                            body.orderId
                        )
                    )
                    .run();

                return json({
                    ok: true
                });
            }

            /*
             * ADMIN USERS
             */

            if (
                path ===
                    "/admin/users" &&
                request.method === "GET"
            ) {

                await requireAdmin(
                    request,
                    env
                );

                const rows =
                    await env.DB
                        .prepare(`
                            SELECT
                                id,
                                username,
                                email,
                                phone,
                                name,
                                is_admin,
                                seller_until,
                                seller_status,
                                balance,
                                online,
                                created_at,
                                last_seen
                            FROM users
                            ORDER BY
                                created_at DESC
                        `)
                        .all();

                return json({
                    ok: true,
                    users:
                        rows.results
                });
            }

            return json(
                {
                    error:
                        "Route tidak ditemukan",
                    path
                },
                404
            );

        } catch (error) {

            if (
                error.message ===
                "UNAUTHORIZED"
            ) {
                return json(
                    {
                        error:
                            "Unauthorized"
                    },
                    401
                );
            }

            if (
                error.message ===
                "ADMIN_ONLY"
            ) {
                return json(
                    {
                        error:
                            "Admin only"
                    },
                    403
                );
            }

            console.error(
                error
            );

            return json(
                {
                    error:
                        "Server error",
                    detail:
                        String(
                            error.message ||
                                error
                        )
                },
                500
            );
        }
    }
};
