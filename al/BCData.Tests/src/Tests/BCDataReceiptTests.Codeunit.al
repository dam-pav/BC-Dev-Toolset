codeunit 50206 "BCD Receipt Tests"
// [FEATURE] [BC Data] E06 receipt fixture
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure IdenticalRequestReturnsStoredResultWithoutSecondMutation()
    var
        RunId: Guid;
        Request: Text;
        FirstResult: Text;
    begin
        RunId := PrepareRun();
        Request := MutationRequest(RunId, CreateGuid(), 4, false);
        FirstResult := Probe.Execute(Request);
        Assert.AreEqual(FirstResult, Probe.Execute(Request), 'Replay must return the exact stored JSON text.');
        CheckState(RunId, 4, 1, 1);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ReusedIdWithDifferentPayloadFailsWithoutMutation()
    var
        RunId: Guid;
        RequestId: Guid;
    begin
        RunId := PrepareRun();
        RequestId := CreateGuid();
        Probe.Execute(MutationRequest(RunId, RequestId, 4, false));
        Commit();
        asserterror Probe.Execute(MutationRequest(RunId, RequestId, 5, false));
        Assert.ExpectedError('BCD_E06_REQUEST_ID_REUSED');
        CheckState(RunId, 4, 1, 1);
        Cleanup(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure LaterMutationDoesNotChangeEarlierReplayResult()
    var
        RunId: Guid;
        Request: Text;
        FirstResult: Text;
    begin
        RunId := PrepareRun();
        Request := MutationRequest(RunId, CreateGuid(), 4, false);
        FirstResult := Probe.Execute(Request);
        Probe.Execute(MutationRequest(RunId, CreateGuid(), 6, false));
        Assert.AreEqual(FirstResult, Probe.Execute(Request), 'Replay is the original result, not current counter state.');
        CheckState(RunId, 10, 2, 2);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure FailedMutationRollsBackReceiptAndCanRetrySameId()
    var
        RunId: Guid;
        RequestId: Guid;
    begin
        RunId := PrepareRun();
        RequestId := CreateGuid();
        Commit();
        asserterror Probe.Execute(MutationRequest(RunId, RequestId, 4, true));
        Assert.ExpectedError('BCD_E06_AFTER_MUTATION');
        CheckState(RunId, 0, 0, 0);
        Probe.Execute(MutationRequest(RunId, RequestId, 4, false));
        CheckState(RunId, 4, 1, 1);
        Cleanup(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure RequestIdIsScopedToFixtureRun()
    var
        FirstRunId: Guid;
        SecondRunId: Guid;
        RequestId: Guid;
    begin
        FirstRunId := PrepareRun();
        SecondRunId := PrepareRun();
        RequestId := CreateGuid();
        Probe.Execute(MutationRequest(FirstRunId, RequestId, 4, false));
        Probe.Execute(MutationRequest(SecondRunId, RequestId, 6, false));
        CheckState(FirstRunId, 4, 1, 1);
        CheckState(SecondRunId, 6, 1, 1);
        Cleanup(FirstRunId);
        CheckState(SecondRunId, 6, 1, 1);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure RemovingReceiptAllowsIdenticalRequestToApplyAgain()
    var
        Receipt: Record "BCD Receipt Fixture";
        RunId: Guid;
        Input: Text;
        FirstResult: Text;
        SecondResult: Text;
    begin
        // E08 negative control: deliberately forget only this completed receipt.
        // This demonstrates the missing lifetime guard; it is not a purge policy.
        RunId := PrepareRun();
        Commit();
        Input := MutationRequest(RunId, CreateGuid(), 4, false);
        FirstResult := Probe.Execute(Input);
        Commit();
        CheckState(RunId, 4, 1, 1);
        Receipt.SetRange("Run ID", RunId);
        Receipt.SetRange(Principal, UserSecurityId());
        Assert.AreEqual(1, Receipt.Count(), 'Only the owned fixture receipt is selected.');
        Receipt.FindFirst();
        Assert.IsTrue(Receipt.Completed, 'The forgotten receipt was completed.');
        Receipt.Delete();
        Commit();
        CheckState(RunId, 4, 1, 0);
        SecondResult := Probe.Execute(Input);
        Commit();
        Assert.AreNotEqual(FirstResult, SecondResult, 'Identical ID/payload is executed again after history is forgotten.');
        CheckState(RunId, 8, 2, 1);
        Cleanup(RunId);
    end;

    local procedure PrepareRun(): Guid
    var
        RunId: Guid;
    begin
        RunId := CreateGuid();
        Probe.Prepare(RunRequest(RunId));
        exit(RunId);
    end;

    local procedure MutationRequest(RunId: Guid; RequestId: Guid; Amount: Integer; FailAfterMutation: Boolean): Text
    var
        Request: JsonObject;
        Output: Text;
    begin
        Request.Add('runId', Format(RunId, 0, 4));
        Request.Add('requestId', Format(RequestId, 0, 4));
        Request.Add('amount', Amount);
        Request.Add('failAfterMutation', FailAfterMutation);
        Request.WriteTo(Output);
        exit(Output);
    end;

    local procedure RunRequest(RunId: Guid): Text
    begin
        exit('{"runId":"' + Format(RunId, 0, 4) + '"}');
    end;

    local procedure CheckState(RunId: Guid; ExpectedTotal: Integer; ExpectedApplies: Integer; ExpectedReceipts: Integer)
    var
        State: JsonObject;
        Token: JsonToken;
    begin
        State.ReadFrom(Probe.Inspect(RunRequest(RunId)));
        State.Get('total', Token);
        Assert.AreEqual(ExpectedTotal, Token.AsValue().AsInteger(), 'Persisted counter total.');
        State.Get('applyCount', Token);
        Assert.AreEqual(ExpectedApplies, Token.AsValue().AsInteger(), 'Mutation count.');
        State.Get('receiptCount', Token);
        Assert.AreEqual(ExpectedReceipts, Token.AsValue().AsInteger(), 'Receipt count.');
        State.Get('pendingCount', Token);
        Assert.AreEqual(0, Token.AsValue().AsInteger(), 'No incomplete receipts.');
    end;

    local procedure Cleanup(RunId: Guid)
    var
        State: JsonObject;
        Token: JsonToken;
    begin
        Probe.Cleanup(RunRequest(RunId));
        State.ReadFrom(Probe.CleanState(RunRequest(RunId)));
        State.Get('runExists', Token);
        Assert.IsFalse(Token.AsValue().AsBoolean(), 'Run removed.');
        State.Get('receiptCount', Token);
        Assert.AreEqual(0, Token.AsValue().AsInteger(), 'Receipts removed.');
    end;

    var
        Probe: Codeunit "BCD Receipt Probe";
        Assert: Codeunit "Library Assert";
}
