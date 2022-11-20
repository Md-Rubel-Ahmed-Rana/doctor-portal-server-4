const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const express = require("express")
const cors = require("cors");
const jwt = require("jsonwebtoken")
const stripe = require("stripe")("sk_test_51M5wpFGyVf5jkl9QYJG9I2mG4F0lGJr6cuCubJ5gNCocwC3fZ9yKEJiBZgfvJepIiNEWDw9ielK846fY3KvYy3PQ00sEsQOZzV");


require("dotenv").config()
const app = express();
const port = process.env.PORT || 5000;


// middleware
app.use(cors())
app.use(express.json());

app.get("/", (req, res) => {
    res.send("Doctor Portal Server is running!!!")
})



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.n72f5gi.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });


const verifyJWT = async(req, res, next) => {
    const authHeader = req.headers.authorization;
    if(!authHeader){
        return res.status(403).send({message: "unauthorized access"})
    }
    const token = authHeader.split(" ")[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
        if(err){
            return res.status(403).send({ message: "unauthorized access" })
        }
        req.decoded = decoded
        next()
    })

}


const server = async() => {
    try {
        const appointmentOptionsCollection = client.db("doctors-portal").collection("appointmentOptions")
        const bookingsCollection = client.db("doctors-portal").collection("bookings")
        const usersCollection = client.db("doctors-portal").collection("users")
        const doctorsCollection = client.db("doctors-portal").collection("doctors")
        const paymentCollection = client.db("doctors-portal").collection("payments")
        
        // verifyAdmin run after verifyJWT
        const verifyAdmin =async (req, res, next) => {
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);
            if (user.role !== "admin") {
                return res.status(403).send({ message: "forbidden access" })
            }
            next()
        }


        app.get('/v2/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            const options = await appointmentOptionCollection.aggregate([
                {
                    $lookup: {
                        from: 'bookings',
                        localField: 'name',
                        foreignField: 'treatment',
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $eq: ['$appointmentDate', date]
                                    }
                                }
                            }
                        ],
                        as: 'booked'
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: 1,
                        booked: {
                            $map: {
                                input: '$booked',
                                as: 'book',
                                in: '$$book.slot'
                            }
                        }
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: {
                            $setDifference: ['$slots', '$booked']
                        }
                    }
                }
            ]).toArray();
            res.send(options);
        })

        app.get("/appointmentOptions", async(req, res) => {
            const date = req.query.date;
            const query = {}
            const cursor = appointmentOptionsCollection.find(query);
            const options = await cursor.toArray()
            const bookinQuery = { appointmentDate : date};
            const alreadyBooked = await bookingsCollection.find(bookinQuery).toArray();

            options.forEach((option) => {
                const optionBooked = alreadyBooked.filter((book) => book.treatment === option.name);
                const bookedSlots = optionBooked.map((book) => book.slot);
                const remainingSlots = option.slots.filter((slot) => !bookedSlots.includes(slot))
                option.slots = remainingSlots
            })

            res.send(options)
        })

        app.get("/appointmentSpecialty", async(req, res) => {
            const query = {}
            const result = await appointmentOptionsCollection.find(query).project({name: 1}).toArray();

            res.send(result)
        })

        app.get("/addPrice", async(req, res) => {
            const filter = {};
            const option = { upsert: true};
            const updatedDoc = {
                $set: {
                    price: 99
                }
            }
            const result = await appointmentOptionsCollection.updateMany(filter, updatedDoc, option);

            res.send(result)
        })

        app.get("/bookings", verifyJWT,  async(req, res) => {
            const email = req.query.email;
            const decodedEmail = req.decoded.email;
            if (email !== decodedEmail){
                return res.status(403).send({ message: "unauthorized access" })
            }
            const query = {email: email};
            const bookings = await bookingsCollection.find(query).toArray();
            res.send(bookings)
        })

        app.get("/bookings/:id", async(req, res) => {
            const id = req.params.id;
            const query = {_id: ObjectId(id)}
            const booking = await bookingsCollection.findOne(query);

            res.send(booking)
        })

        app.post("/create-payment-intent", async(req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: "usd",
                automatic_payment_methods: {
                    enabled: true,
                },
            });

            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        });

        app.post("/payments", async(req, res) => {
            const payment = req.body;
            const result = await paymentCollection.insertOne(payment);
            const id = payment.booking_id;
            const filter = {_id: ObjectId(id)};
            const option = {upsert: true}
            const updatedDoc = {
                $set: {
                    paid: true,
                    transectionId: payment.transectionId
                }
            }
            const updatedResult = await bookingsCollection.updateOne(filter, updatedDoc, option);
            console.log(updatedResult);
            res.send(result)
        })

        app.get("/jwt", async(req, res) => {
            const email = req.query.email;
            const query = {email: email};
            const user = await usersCollection.findOne(query);
            if(user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, {expiresIn: "24h"});
                return res.send({accessToken: token})
            }
            return res.status(403).send({message: "unauthorized access"})
        })

        app.get("/users", async(req, res) => {
            const query = {}
            const users = await usersCollection.find(query).toArray();
            res.send(users)
        })

        app.get("/users/admin/:email", async(req, res) => {
            const email = req.params.email;
            const query = {email : email};
            const user = await usersCollection.findOne(query);

            res.send({isAdmin: user?.role === "admin"})
        })

        app.get("/doctors", verifyJWT, verifyAdmin, async(req, res) => {
            const result = await doctorsCollection.find({}).toArray();
            res.send(result)
        })

        app.post("/bookings", async(req, res) => {
            const booking = req.body;
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment
            }

            const alreadyBooked = await bookingsCollection.find(query).toArray();
            if(alreadyBooked.length){
                const message = `You already have a booking on ${booking.appointmentDate}`;
                return res.send({acknowledged: false, message})
            }


            const result = await bookingsCollection.insertOne(booking);
            res.send(result)
        })

        app.post("/users", async(req, res) => {
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result)
        })

        app.post("/doctors", verifyJWT, verifyAdmin, async(req,res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result)
        })

        app.put("/users/admin/:id", verifyJWT, verifyAdmin, async(req, res) => {
            const id = req.params.id;
            const filter = {_id: ObjectId(id)};
            const option = {upsert: true};
            const updatedDoc = {
                $set: {role: "admin"}
            }
            const result = await usersCollection.updateOne(filter, updatedDoc, option)
            res.send(result)
        })

        app.delete("/doctors/:id", verifyJWT, verifyAdmin, async(req, res) => {
            const id = req.params.id;
            const query = {_id: ObjectId(id)};
            const result = await doctorsCollection.deleteOne(query);
            res.send(result)
        })

    } catch (error) {
        console.log(error);
    }
}

server()


app.listen(port, () => console.log(`Doctor Portal Server is running on port ${port}`))