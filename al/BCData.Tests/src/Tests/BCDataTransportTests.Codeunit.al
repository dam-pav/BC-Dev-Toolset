codeunit 50201 "BCD Transport Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure EchoPreservesTextAndJsonTypes()
    var
        Probe: Codeunit "BCD Transport Probe";
        Assert: Codeunit "Library Assert";
        Response: JsonObject;
        Value: JsonToken;
        Payload: JsonObject;
        Input: Text;
    begin
        // [SCENARIO] E01: AL preserves the Text envelope and nested JSON types.
        // HTTP framing and authentication require the separate HTTP experiment.
        Input := '{"unicode":"Živjo 世界 😀","escaped":"quote: \" slash: \\ newline: \n","empty":"","number":123.456,"boolean":true,"null":null,"array":[0,false,""]}';
        Response.ReadFrom(Probe.Echo(Input));
        Response.Get('inputJson', Value);
        Assert.AreEqual(Input, Value.AsValue().AsText(), 'E01: Original Text must round-trip exactly.');
        Response.Get('company', Value);
        Assert.AreEqual(CompanyName(), Value.AsValue().AsText(), 'E01: Company context must be explicit.');
        Response.Get('payload', Value);
        Payload := Value.AsObject();
        Payload.Get('number', Value);
        Assert.AreEqual(123.456, Value.AsValue().AsDecimal(), 'E01: Decimal must remain numeric.');
        Payload.Get('boolean', Value);
        Assert.IsTrue(Value.AsValue().AsBoolean(), 'E01: Boolean must remain boolean.');
        Payload.Get('null', Value);
        Assert.IsTrue(Value.AsValue().IsNull(), 'E01: Null must remain null.');
        Payload.Get('empty', Value);
        Assert.AreEqual('', Value.AsValue().AsText(), 'E01: Empty Text must remain empty.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure DeliberateErrorIsStable()
    var
        Probe: Codeunit "BCD Transport Probe";
        Assert: Codeunit "Library Assert";
    begin
        // [SCENARIO] E01: The intentional AL error has an input-independent marker.
        asserterror Probe.Fail('{"private":"must not appear in error"}');
        Assert.ExpectedError('BCD_E01_DELIBERATE_ERROR');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure InvalidJsonIsRejected()
    var
        Probe: Codeunit "BCD Transport Probe";
        Assert: Codeunit "Library Assert";
    begin
        // [SCENARIO] E01: Malformed inner JSON is rejected before response serialization.
        asserterror Probe.Echo('{');
        Assert.ExpectedError('BCD_E01_INVALID_JSON');
    end;
}
